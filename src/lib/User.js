import { EventEmitter } from 'events';
import _ from 'underscore';
import Users from '../models/users.js';
import UserInfo from '../models/user_info.js';
import { getBlob, getTextBlob, isBlobHash, putBlob, putTextBlob } from './blobStore.js';
import { verifySaltedSha1PasswordHash } from './passwordHash.js';

class User extends EventEmitter {
    users = {};

    sessionToChannels = {};

    constructor(log, options) {
        super();

        this.log = log;
        this.options = options || {};
        this.serverId = Number(this.options.serverId || 1);
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

    async addUser(user_data) {
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
            textureHash: [],
            commentHash: [],
            textureBlob: '',
            commentBlob: '',
            hash: '',
            comment: '',
            pluginIdentity: '',
            pluginContext: [],
            texture: []
        };
        let rememberedChannel = null;

        let matchedUser = null;
        let rejectAuth = null;
        const maxUsers = Number(this.options.maxUsers || 0);
        const serverPassword =
            typeof this.options.serverPassword === 'string' ? this.options.serverPassword : '';
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

        if (
            maxUsers > 0 &&
            Object.keys(this.users).length >= maxUsers &&
            user_data.name !== 'SuperUser'
        ) {
            return {
                id: null,
                reject: {
                    type: 6,
                    reason: 'Server full'
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
                    : Buffer.from(String(matchedUser.texture));

                if (Buffer.isBuffer(matchedUser.texture) || !isBlobHash(String(matchedUser.texture))) {
                    const textureBlob = await putBlob(rawTexture);
                    user_model.texture = rawTexture;
                    user_model.textureBlob = textureBlob;
                    user_model.textureHash = Buffer.from(textureBlob, 'hex');

                        await Users.update(
                            {
                                texture: textureBlob
                            },
                            {
                                where: {
                                    server_id: this.serverId,
                                    user_id: matchedUser.user_id
                                }
                            }
                    ).catch(err => {
                        this.log.error(new Error(err));
                    });
                } else {
                    const textureBlob = String(matchedUser.texture);
                    const texture = await getBlob(textureBlob);

                    if (texture) {
                        user_model.texture = texture;
                        user_model.textureBlob = textureBlob;
                        user_model.textureHash = Buffer.from(textureBlob, 'hex');
                    }
                }
            }

            for (const { key, value } of rows) {
                if (key === 2) {
                    if (value && value.length > 0) {
                        const commentValue = String(value);

                        if (!isBlobHash(commentValue)) {
                            const commentBlob = await putTextBlob(commentValue);
                            user_model.comment = commentValue;
                            user_model.commentBlob = commentBlob;
                            user_model.commentHash = Buffer.from(commentBlob, 'hex');

                            await UserInfo.update(
                                {
                                    value: commentBlob
                                },
                                {
                                    where: {
                                        server_id: this.serverId,
                                        user_id: matchedUser.user_id,
                                        key: 2
                                    }
                                }
                            ).catch(err => {
                                this.log.error(new Error(err));
                            });
                        } else {
                            user_model.commentBlob = commentValue;
                            user_model.commentHash = Buffer.from(commentValue, 'hex');
                            const comment = await getTextBlob(commentValue);
                            if (comment) {
                                user_model.comment = comment;
                            }
                        }
                    }
                }
                if (key === 3 && user_data.hash) {
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
        }

        const id = this.id++;

        this.users[id] = user_model;

        this.users[id].session = id;

        if (this.users[id].session === 0) {
            this.users[id].session = 100;
        }

        this.sessionToChannels[this.users[id].session] = this.users[id].channelId;
        return {
            id,
            reject: rejectAuth
        };
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

        _.each(user_data, (item, key) => {
            if (user[key] !== undefined) {
                user[key] = item;
            }
        });

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
        delete this.users[id];
    }
}

export default User;
