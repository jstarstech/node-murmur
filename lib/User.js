
"use strict";

var EventEmitter = require('events').EventEmitter;
var _ = require('underscore');

var User = function (options) {
    var self = this;
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

User.prototype.addUser = function(user_data) {
    var user_model = {
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

    _.each(user_data, function (item, key, list) {
        if (user_model[key] !== undefined) {
            user_model[key] = item;
        }
    });
    var id = this.id++;
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
    var user = this.getUser(id);

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
