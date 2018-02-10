
"use strict";

var EventEmitter = require('events').EventEmitter;
var _ = require('underscore');

var User = function (options) {
    var self = this;
    this.options = options || {};
    this.id = 99;
};
User.prototype = Object.create(EventEmitter.prototype);
User.prototype.users = {};

User.prototype.addUser = function(user_data) {
    var user_model = {
        actor: null,
        session: null,
        name: null,
        userId: null,
        deaf: null,
        mute: null,
        recording: null,
        suppress: null,
        selfMute: null,
        selfDeaf: null,
        channelId: null,
        prioritySpeaker: false,
        textureHash: null,
        commentHash: null,
        hash: null,
        comment: null,
        pluginIdentity: null,
        pluginContext: null,
        texture: null
    };

    _.each(user_data, function (item, key, list) {
        if (user_model[key] !== undefined) {
            user_model[key] = item;
        }
    });

    var id = this.id++;
    this.users[id] = user_model;

    this.users[id].session = id * 100;

    if (this.users[id].session === 0) {
        this.users[id].session = 100;
    }

    return id;
};

User.prototype.getUser = function(id) {
    var user_model = {
        // 'actor': null,
        session: null,
        name: null,
        // 'user_id': null,
        deaf: null,
        mute: null,
        recording: null,
        suppress: null,
        self_mute: null,
        self_deaf: null,
        channel_id: null,
        priority_speaker: null,
        texture_hash: null,
        comment_hash: null,
        hash: null,
        comment: null,
        plugin_identity: null,
        plugin_context: null,
        texture: null
    };

    if ( ! this.users[id]) {
        return user_model;
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

    return user;
};

User.prototype.deleteUser = function(id) {
    delete this.users[id];
};

module.exports = User;
