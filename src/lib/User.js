import crypto from 'crypto';
import { EventEmitter } from 'events';
import _ from 'underscore';
import Users from '../models/users.js';
import UserInfo from '../models/user_info.js';
import { verifySaltedSha1PasswordHash } from './passwordHash.js';
import SessionPool from './sessionPool.js';

function sha1Buffer(value) {
    return crypto.createHash('sha1').update(value).digest();
}

class User extends EventEmitter {
    users = {};

    sessionToChannels = {};
    activeRegisteredUserIds = new Map();
    pendingRegisteredUserIds = new Set();

    constructor(log, options) {
        super();

        this.log = log;
        this.options = options || {};
        this.serverId = Number(this.options.serverId || 1);
        this.sessionPool = this.options.sessionPool || new SessionPool();
        this.id = 100;
    }

    async _persistLastChannel(user) {
        if (
            user.userId === null ||
            user.userId === undefined ||
            user.channelId === null ||
            user.channelId === undefined
        ) {
            return;
        }

        await Users.update(
            {
                lastchannel: user.channelId
            },
            {
                where: {
                    server_id: this.serverId,
                    user_id: user.userId
                }
            }
        ).catch(err => {
            this.log.error(new Error(err));
        });
    }

    async addUser(user_data, options = {}) {
        const allocateSession = options.allocateSession !== false;
        const user_model = {
            session: null,
            name: '',
            userId: null,
            deaf: false,
            mute: false,
            recording: false,
            suppress: false,
            selfMute: false,
            selfDeaf: false,
            channelId: 0,
            prioritySpeaker: false,
            textureHash: Buffer.alloc(0),
            commentHash: Buffer.alloc(0),
            hash: '',
            comment: '',
            pluginIdentity: '',
            pluginContext: [],
            texture: Buffer.alloc(0)
        };
        let rememberedChannel = null;

        let matchedUser = null;
        let rejectAuth = null;
        const serverPassword = typeof this.options.serverPassword === 'string' ? this.options.serverPassword : '';
        const usernameValidator = this.options.usernameValidator;

        if (!user_data.name) {
            return {
                id: null,
                reject: {
                    type: 2,
                    reason: 'Invalid username'
                }
            };
        }

        if (usernameValidator && !usernameValidator.test(user_data.name)) {
            return {
                id: null,
                reject: {
                    type: 2,
                    reason: 'Invalid username'
                }
            };
        }

        if (user_data.name === 'SuperUser') {
            const superUser = await Users.findOne({
                where: {
                    server_id: this.serverId,
                    user_id: 0
                }
            }).catch(err => {
                this.log.error(new Error(err));

                return null;
            });

            if (!superUser || !superUser.pw || !user_data.password) {
                rejectAuth = {
                    type: 3,
                    reason: 'Wrong password'
                };
            } else if (verifySaltedSha1PasswordHash(user_data.password, superUser.pw)) {
                matchedUser = superUser;
            } else {
                rejectAuth = {
                    type: 3,
                    reason: 'Wrong password'
                };
            }
        }

        if (!matchedUser && !rejectAuth && serverPassword && user_data.password !== serverPassword) {
            rejectAuth = {
                type: 4,
                reason: 'Wrong password'
            };
        }

        const namedUser = await Users.findOne({
            where: {
                server_id: this.serverId,
                name: user_data.name
            }
        }).catch(err => {
            this.log.error(new Error(err));

            return null;
        });

        if (!matchedUser && !rejectAuth && namedUser) {
            const namedUserInfo = await UserInfo.findOne({
                where: {
                    server_id: this.serverId,
                    user_id: namedUser.user_id,
                    key: 3
                }
            }).catch(err => {
                this.log.error(new Error(err));

                return null;
            });

            const namedCertHash = namedUserInfo ? namedUserInfo.value : null;

            if (!user_data.hash || namedCertHash !== user_data.hash) {
                rejectAuth = {
                    type: 8,
                    reason: 'Wrong certificate hash'
                };
            } else {
                matchedUser = namedUser;
            }
        }

        if (!matchedUser && !rejectAuth && user_data.hash) {
            const matchedInfo = await UserInfo.findOne({
                where: {
                    server_id: this.serverId,
                    key: 3,
                    value: user_data.hash
                }
            }).catch(err => {
                this.log.error(new Error(err));

                return null;
            });

            if (matchedInfo && matchedInfo.user_id !== null && matchedInfo.user_id !== undefined) {
                matchedUser = await Users.findOne({
                    where: {
                        server_id: this.serverId,
                        user_id: matchedInfo.user_id
                    }
                }).catch(err => {
                    this.log.error(new Error(err));

                    return null;
                });
            }
        }

        let reservedRegisteredUserId = null;
        if (matchedUser) {
            const registeredUserId = Number(matchedUser.user_id);
            if (
                this.activeRegisteredUserIds.has(registeredUserId) ||
                this.pendingRegisteredUserIds.has(registeredUserId)
            ) {
                return {
                    id: null,
                    reject: {
                        type: 5,
                        reason: 'Username is already in use'
                    }
                };
            }

            this.pendingRegisteredUserIds.add(registeredUserId);
            reservedRegisteredUserId = registeredUserId;
        }

        try {
            if (matchedUser) {
                const rows = await UserInfo.findAll({
                    where: {
                        server_id: this.serverId,
                        user_id: matchedUser.user_id
                    }
                }).catch(err => {
                    this.log.error(new Error(err));

                    return [];
                });

                user_model.userId = matchedUser.user_id;
                user_model.channelId = matchedUser.lastchannel || 0;
                rememberedChannel = matchedUser.lastchannel;

                if (matchedUser.texture && matchedUser.texture.length > 0) {
                    const rawTexture = Buffer.isBuffer(matchedUser.texture)
                        ? Buffer.from(matchedUser.texture)
                        : Buffer.from(matchedUser.texture, 'utf8');

                    user_model.texture = rawTexture;
                    user_model.textureHash = sha1Buffer(rawTexture);
                }

                for (const { key, value } of rows) {
                    if (Number(key) === 2) {
                        if (value && value.length > 0) {
                            const commentValue = String(value);
                            user_model.comment = commentValue;
                            user_model.commentHash = sha1Buffer(commentValue);
                        }
                    }
                    if (Number(key) === 3 && user_data.hash) {
                        user_model.hash = value;
                    }
                }
            }

            _.each(user_data, (item, key) => {
                if (key === 'channelId' && rememberedChannel !== null && rememberedChannel !== undefined) {
                    return;
                }

                if (user_model[key] !== undefined) {
                    user_model[key] = item;
                }
            });

            if (matchedUser) {
                user_model.name = matchedUser.name;
            } else {
                user_model.name = user_data.name;
            }

            const id = this.id++;

            this.users[id] = user_model;

            if (allocateSession) {
                this.activateUser(id);
            }

            return {
                id,
                reject: rejectAuth
            };
        } catch (err) {
            if (reservedRegisteredUserId !== null) {
                this.pendingRegisteredUserIds.delete(reservedRegisteredUserId);
            }

            throw err;
        }
    }

    activateUser(id) {
        const user = this.users[id];

        if (!user) {
            return {};
        }

        if (user.session === null || user.session === undefined) {
            user.session = this.sessionPool.get();
        }

        this.sessionToChannels[user.session] = user.channelId;

        if (user.userId !== null && user.userId !== undefined) {
            const registeredUserId = Number(user.userId);
            this.pendingRegisteredUserIds.delete(registeredUserId);
            this.activeRegisteredUserIds.set(registeredUserId, id);
        }

        return user;
    }

    getUser(id) {
        if (!this.users[id]) {
            return {};
        }

        return this.users[id];
    }

    async updateUser(id, user_data) {
        const user = this.users[id];

        if (!user) {
            return {};
        }

        const hadUserId = user.userId !== null && user.userId !== undefined;
        const previousUserId = hadUserId ? Number(user.userId) : null;
        const hasUserIdChange = Object.prototype.hasOwnProperty.call(user_data, 'userId');
        const nextUserId =
            hasUserIdChange && user_data.userId !== null && user_data.userId !== undefined
                ? Number(user_data.userId)
                : null;

        if (hasUserIdChange && nextUserId !== null) {
            const activeSessionId = this.activeRegisteredUserIds.get(nextUserId);
            if (activeSessionId !== undefined && activeSessionId !== id) {
                throw new Error('Registered user is already active');
            }
        }

        _.each(user_data, (item, key) => {
            if (user[key] !== undefined) {
                user[key] = item;
            }
        });

        if (hasUserIdChange) {
            if (previousUserId !== null) {
                const activeSessionId = this.activeRegisteredUserIds.get(previousUserId);
                if (activeSessionId === id) {
                    this.activeRegisteredUserIds.delete(previousUserId);
                }
            }

            if (nextUserId !== null) {
                this.activeRegisteredUserIds.set(nextUserId, id);
            }
        }

        this.sessionToChannels[this.users[id].session] = this.users[id].channelId;

        if (Object.prototype.hasOwnProperty.call(user_data, 'channelId')) {
            await this._persistLastChannel(user);
        }

        return user;
    }

    async deleteUser(id) {
        const user = this.users[id];

        if (!user) {
            return;
        }

        delete this.sessionToChannels[user.session];

        if (user.userId !== null && user.userId !== undefined) {
            const registeredUserId = Number(user.userId);
            const activeSessionId = this.activeRegisteredUserIds.get(registeredUserId);
            if (activeSessionId === id) {
                this.activeRegisteredUserIds.delete(registeredUserId);
            }
            this.pendingRegisteredUserIds.delete(registeredUserId);
        }

        delete this.users[id];
    }

    releaseSession(sessionId) {
        this.sessionPool.reclaim(sessionId);
    }
}

export default User;
