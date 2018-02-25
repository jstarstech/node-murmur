
"use strict";

const EventEmitter = require('events').EventEmitter;
const _ = require('underscore');

let User = function (db, log, options) {
    this.db = db;
    this.log = log;
    this.options = options || {};
    this.id = 100;
};

User.prototype = Object.create(EventEmitter.prototype);

User.prototype.users = {"0": {
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
    }};
User.prototype.sessionToChannels = {};

User.prototype.addUser = async function(user_data) {
    let user_model = {
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

    let row = await this.db['user_info'].findOne({
        where: {
            server_id: 1,
            key: 3,
            value: user_data.hash,
        }
    }).catch(function (err) {
        log.error(new Error(err));

        return {};
    });

    if (row.user_id) {
        let user = await this.db['users'].findOne({
            where: {
                server_id: 1,
                user_id: row.user_id
            }
        }).catch(function (err) {
            log.error(new Error(err));

            return {};
        });

        let rows = await this.db['user_info'].findAll({
            where: {
                server_id: 1,
                user_id: row.user_id
            }
        }).catch(function (err) {
            log.error(new Error(err));

            return [];
        });

        user_model.userId = user.user_id;
        // user_model.textureHash = user.texture;
        user_model.channelId = user.lastchannel || 0;

        rows.forEach(function(row) {
            if (row.key === 2) {
                user_model.comment = row.value;
            }
            if (row.key === 3) {
                user_model.hash = row.value;
            }
        })
    }

    _.each(user_data, function (item, key, list) {
        if (user_model[key] !== undefined) {
            user_model[key] = item;
        }
    });
console.log(user_model);
    const id = this.id++;

    this.users[id] = user_model;

    this.users[id].session = id;

    if (this.users[id].session === 0) {
        this.users[id].session = 100;
    }

    this.sessionToChannels[this.users[id].session] = this.users[id].channelId;

    return id;
};

User.prototype.getUser = function(id) {
    if ( ! this.users[id]) {
        return {};
    }

    return this.users[id];
};

User.prototype.updateUser = function(id, user_data) {
    let user = this.getUser(id);

    if ( ! user) {
        return {};
    }

    _.each(user_data, function (item, key, list) {
        if (user[key] !== undefined) {
            user[key] = item;
        }
    });

    this.sessionToChannels[this.users[id].session] = this.users[id].channelId;

    return user;
};

User.prototype.deleteUser = function(id) {
    delete this.sessionToChannels[this.users[id].session];
    delete this.users[id];
};

module.exports = User;
