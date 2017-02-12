
"use strict";

var EventEmitter = require('events').EventEmitter;

var User = function (options) {
    var self = this;
    this.options = options || {};

};
User.prototype = Object.create(EventEmitter.prototype);
User.prototype.users = [];

User.prototype.addUser = function(user) {
    var user_model = {
        'actor': null,
        'session': null,
        'name': null,
        'user_id': null,
        'deaf': null,
        'mute': null,
        'recording': null,
        'suppress': null,
        'self_mute': null,
        'self_deaf': null,
        'channel_id': null,
        'priority_speaker': false,
        'texture_hash': null,
        'comment_hash': null,
        'hash': null,
        // 'comment': null,
        // 'plugin_identity': null,
        // 'plugin_context': null,
        // 'texture': null
    };

    for (var attr in user) {
        if (user_model[attr] !== undefined) {
            user_model[attr] = user[attr];
        }
    }

    var uid = this.users.push(user_model) - 1;

    this.users[uid].session = uid * 100;

    if (this.users[uid].session == 0) {
        this.users[uid].session = 100;
    }

    return uid;
};

User.prototype.getUser = function(id) {
    var user_model = {
        'actor': null,
        'session': null,
        'name': null,
        'user_id': null,
        'deaf': null,
        'mute': null,
        'recording': null,
        'suppress': null,
        'selfMute': null,
        'selfDeaf': null,
        'self_mute': null,
        'self_deaf': null,
        'channel_id': null,
        'priority_speaker': null,
        'texture_hash': null,
        'comment_hash': null,
        'hash': null,
        'comment': null,
        'plugin_identity': null,
        'plugin_context': null,
        'texture': null
    };

    if ( ! this.users[id]) {
        return user_model;
    }

    return this.users[id];
};

User.prototype.updateUser = function(id, obj) {
    var user = this.getUser(id);

    if ( ! user) {
        return {};
    }

    for (var attr in obj) {
        user[attr] = obj[attr];
    }

    return user;
};

User.prototype.deleteUser = function(id) {
    delete this.users[id];
};

module.exports = User;
