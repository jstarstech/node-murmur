const { EventEmitter } = require('events');
const _ = require('underscore');

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
      texture: [],
    },
  };

  sessionToChannels = {};

  constructor(db, log, options) {
    super();

    this.db = db;
    this.log = log;
    this.options = options || {};
    this.id = 100;
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
      texture: [],
    };

    const row = await this.db.user_info.findOne({
      where: {
        server_id: 1,
        key: 3,
        value: user_data.hash,
      },
    }).catch((err) => {
      log.error(new Error(err));

      return {};
    });

    if (row && row.user_id) {
      const user = await this.db.users.findOne({
        where: {
          server_id: 1,
          user_id: row.user_id,
        },
      }).catch((err) => {
        log.error(new Error(err));

        return {};
      });

      const rows = await this.db.user_info.findAll({
        where: {
          server_id: 1,
          user_id: row.user_id,
        },
      }).catch((err) => {
        log.error(new Error(err));

        return [];
      });

      user_model.userId = user.user_id;
      // user_model.textureHash = user.texture;
      user_model.channelId = user.lastchannel || 0;

      rows.forEach(({ key, value }) => {
        if (key === 2) {
          user_model.comment = value;
        }
        if (key === 3) {
          user_model.hash = value;
        }
      });
    }

    _.each(user_data, (item, key, list) => {
      if (user_model[key] !== undefined) {
        user_model[key] = item;
      }
    });

    const id = this.id++;

    this.users[id] = user_model;

    this.users[id].session = id;

    if (this.users[id].session === 0) {
      this.users[id].session = 100;
    }

    this.sessionToChannels[this.users[id].session] = this.users[id].channelId;

    return id;
  }

  getUser(id) {
    if (!this.users[id]) {
      return {};
    }

    return this.users[id];
  }

  updateUser(id, user_data) {
    const user = this.getUser(id);

    if (!user) {
      return {};
    }

    _.each(user_data, (item, key, list) => {
      if (user[key] !== undefined) {
        user[key] = item;
      }
    });

    this.sessionToChannels[this.users[id].session] = this.users[id].channelId;

    return user;
  }

  deleteUser(id) {
    delete this.sessionToChannels[this.users[id].session];
    delete this.users[id];
  }
}

module.exports = User;
