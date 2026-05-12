import { EventEmitter } from 'events';
import crypto from 'crypto';
import _ from 'underscore';
import Users from '../models/users.js';
import UserInfo from '../models/user_info.js';
import { verifySaltedSha1PasswordHash } from './passwordHash.js';

class User extends EventEmitter {
    users = {
        0: {
            session: 10,
            name: 'Telegram',
            userId: null,
            deaf: false,
            mute: false,
            recording: false,
            suppress: false,
            selfMute: false,
            selfDeaf: false,
            channelId: 30,
            prioritySpeaker: false,
            textureHash: [],
            commentHash: [],
            hash: '',
            comment: '',
            pluginIdentity: '',
            pluginContext: [],
            texture: []
        }
    };

    sessionToChannels = {};

    constructor(log, options) {
        super();

        this.log = log;
        this.options = options || {};
        this.id = 100;
    }

    isSha1Like(value) {
        return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
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
                    server_id: 1,
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
            hash: '',
            comment: '',
            pluginIdentity: '',
            pluginContext: [],
            texture: []
        };
        let rememberedChannel = null;

        let matchedUser = null;
        let rejectAuth = null;

        if (!user_data.name) {
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
                    server_id: 1,
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

        const namedUser = await Users.findOne({
            where: {
                server_id: 1,
                name: user_data.name
            }
        }).catch(err => {
            this.log.error(new Error(err));

            return null;
        });

        if (!matchedUser && !rejectAuth && namedUser) {
            const namedUserInfo = await UserInfo.findOne({
                where: {
                    server_id: 1,
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
                    server_id: 1,
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
                        server_id: 1,
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
                    server_id: 1,
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
                user_model.texture = Buffer.from(matchedUser.texture);
                user_model.textureHash = crypto.createHash('sha1').update(user_model.texture).digest();
            }

            rows.forEach(({ key, value }) => {
                if (key === 2) {
                    if (value && value.length > 0 && !this.isSha1Like(value)) {
                        user_model.comment = value;
                        user_model.commentHash = crypto.createHash('sha1').update(Buffer.from(value)).digest();
                    }
                }
                if (key === 3 && user_data.hash) {
                    user_model.hash = value;
                }
            });
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
