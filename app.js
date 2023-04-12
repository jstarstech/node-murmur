const dgram = require('dgram');
const tls = require('tls');
const os = require('os');
const _ = require('underscore');
const BufferPack = require('bufferpack');
const config = require('config');
const log4js = require('log4js');
const log4js_extend = require('log4js-extend');
const util = require('./lib/util');
const db = require('./models/index');
const MumbleConnection = require('./lib/MumbleConnection');
const User = require('./lib/User');

log4js.configure('./config/log4js.json');
log4js_extend(log4js, {
  path: __dirname,
  format: 'at @name (@file:@line:@column)',
});
const log = log4js.getLogger();

async function getChannels(server_id) {
  const channels = {};

  const dbChannels = await db.channels
    .findAll({
      where: {
        server_id,
      },
    })
    .catch((err) => {
      log.error(new Error(err));
    });

  for (const dbChannel of dbChannels) {
    channels[dbChannel.channel_id] = dbChannel;

    const channelInfos = await db.channel_info
      .findAll({
        where: {
          server_id,
          channel_id: dbChannel.channel_id,
        },
      })
      .catch((err) => {
        log.error(new Error(err));

        return [];
      });

    for (const channelInfo of channelInfos) {
      if (channelInfo.key === 0) {
        channels[channelInfo.channel_id].description = channelInfo.value;
      }

      if (channelInfo.key === 1) {
        channels[channelInfo.channel_id].position = channelInfo.value;
      }
    }
  }

  return channels;
}

async function startServer(server_id) {
  const serverConfig = {};

  const dbConfigs = await db.config
    .findAll({
      where: {
        server_id,
      },
    })
    .catch((err) => {
      log.error(new Error(err));

      return [];
    });

  for (const dbConfig of dbConfigs) {
    if (/^\d+$/.test(dbConfig.value)) {
      dbConfig.value = parseInt(dbConfig.value);
    }

    if (dbConfig.value === 'true' || dbConfig.value === 'false') {
      dbConfig.value = (dbConfig.value === 'true');
    }
    serverConfig[dbConfig.key] = dbConfig.value;
  }

  if (typeof serverConfig.port === 'undefined') {
    serverConfig.port = 64738;
  }

  const channels = await getChannels(server_id);

  const Users = new User(db, log);

  const options = {
    key: serverConfig.key,
    cert: serverConfig.certificate,
    requestCert: serverConfig.certrequired,
    rejectUnauthorized: false,
  };

  tls.createServer(options, (socket) => {
    socket.setKeepAlive(true, 10000);
    socket.setTimeout(10000);
    socket.setNoDelay(false);

    log.info('TLS Client authorized:', socket.authorized);

    if (!socket.authorized) {
      log.info('TLS authorization error:', socket.authorizationError);
    }

    let uid;
    const auth = false;
    const connection = new MumbleConnection(socket, Users);

    function broadcastListener(type, message, sender_uid) {
      if (sender_uid !== undefined) {
        if (type !== 'UserState' && sender_uid === uid) {
          return;
        }
      }

      if (type === 'TextMessage' && message.channelId.indexOf(Users.getUser(uid).channelId) === -1) {
        return;
      }

      connection.sendMessage(type, message);
    }

    Users.on('broadcast', broadcastListener);

    function broadcastAudio(packet, source_session) {
      const user = Users.getUser(uid);

      if (user.session === source_session) {
        return;
      }

      if (user.channelId !== Users.sessionToChannels[source_session]) {
        return;
      }

      if (user.selfDeaf === true) {
        return;
      }

      connection.socket.write(packet);
    }

    Users.on('broadcast_audio', broadcastAudio);

    connection.on('error', (err) => {
      log.info('User disconnected', err);
    });

    connection.on('disconnect', () => {
      log.info('User disconnected');

      if (Users.getUser(uid).session) {
        Users.emit('broadcast', 'UserRemove', { session: Users.getUser(uid).session }, uid);
        Users.deleteUser(uid);
      }

      Users.removeListener('broadcast', broadcastListener);
      Users.removeListener('broadcast_audio', broadcastAudio);
    });

    connection.on('textMessage', (m) => {
      if (m.channelId.length === 0) {
        return;
      }

      const ms = {
        actor: Users.getUser(uid).session,
        session: [],
        channelId: m.channelId,
        treeId: [],
        message: m.message,
      };

      Users.emit('broadcast', 'TextMessage', ms, uid);
    });

    connection.on('permissionQuery', (m) => {
      const permissions = util.writePermissions({
        Enter: 0x04,
        Traverse: 0x02,
        // All: 0xf07ff
      });

      /* connection.sendMessage('PermissionQuery', {
                channelId: m.channelId,
                permissions: permissions,
                flush: false
            }); */
      console.log(m);

      connection.sendMessage('PermissionDenied', {
        channelId: m.channelId,
        type: 1,
        permission: permissions,
      });
    });

    connection.on('acl', (m) => {
      console.log(m);

      if (m.query) {
        connection.sendMessage('ACL', {
          groups: [],
          acls: [],
          channelId: 59,
          inherit_acls: true,
          query: false,
        });
      }
    });

    let authUserState = {};
    connection.on('userState', (m) => {
      const user = Users.getUser(uid);

      const updateUserState = {
        session: user.session || null,
        actor: user.session || null,
      };

      if (m.hasOwnProperty('deaf') && m.deaf !== user.deaf) {
        updateUserState.deaf = m.deaf;
      }

      if (m.hasOwnProperty('mute') && m.mute !== user.mute) {
        updateUserState.mute = m.mute;
      }

      if (m.hasOwnProperty('recording') && m.recording !== user.recording) {
        updateUserState.recording = m.recording;
      }

      if (m.hasOwnProperty('suppress') && m.suppress !== user.suppress) {
        updateUserState.suppress = m.suppress;
      }

      if (m.hasOwnProperty('selfMute') && m.selfMute !== user.selfMute) {
        updateUserState.selfMute = m.selfMute;
      }

      if (m.hasOwnProperty('selfDeaf') && m.selfDeaf !== user.selfDeaf) {
        updateUserState.selfDeaf = m.selfDeaf;
      }

      if (m.hasOwnProperty('channelId') && m.channelId !== user.channelId) {
        updateUserState.channelId = m.channelId;
      }

      if (m.hasOwnProperty('prioritySpeaker') && m.prioritySpeaker !== user.prioritySpeaker) {
        updateUserState.prioritySpeaker = m.prioritySpeaker;
      }

      if (m.hasOwnProperty('pluginIdentity') && m.pluginIdentity !== user.pluginIdentity) {
        updateUserState.pluginIdentity = m.pluginIdentity;
      }

      if (m.hasOwnProperty('pluginContext') && m.pluginContext !== user.pluginContext) {
        updateUserState.pluginContext = m.pluginContext;
      }

      if (auth === false) {
        authUserState = updateUserState;
      } else {
        Users.updateUser(uid, updateUserState);
      }

      Users.emit('broadcast', 'UserState', updateUserState, uid);
    });

    connection.sendMessage('Version', {
      version: util.encodeVersion(1, 2, 4),
      release: `1.2.4-0.1${os.platform()}`,
      os: os.platform(),
      osVersion: os.release(),
    });

    connection.on('authenticate', async (m) => {
      uid = await Users.addUser({
        name: m.username,
        password: m.password,
        opus: m.opus,
        hash: socket.getPeerCertificate().fingerprint.replace(/:/g, '').toLowerCase(),
        channelId: serverConfig.defaultchannel,
      });

      Users.updateUser(uid, authUserState);

      log.debug(m);

      connection.sessionId = Users.getUser(uid).session;

      // connection.sendMessage('Reject', { reason: 'omg test'});
      // return;

      connection.sendMessage('CryptSetup', {
        key: new Buffer.from('08dvzUdMpExPo9KUxgVYwg==', 'base64'),
        clientNonce: new Buffer.from('vL2nJU/FURMQIu0HF0XlOA==', 'base64'),
        serverNonce: new Buffer.from('KhXfffcCF/+WGd8YojVbSQ==', 'base64'),
      });

      connection.sendMessage('CodecVersion', {
        alpha: -2147483637,
        beta: 0,
        preferAlpha: true,
        opus: true,
      });

      _.each(channels, (channel, key, list) => {
        connection.sendMessage('ChannelState', {
          channelId: channel.channel_id,
          parent: channel.parent_id,
          name: channel.name,
          links: [],
          description: channel.description,
          linksAdd: [],
          linksRemove: [],
          temporary: false,
          position: channel.position,
          descriptionHash: null,
        });
      });

      /*            let permissions = util.writePermissions({
                            None: 0x00,
                            Write: 0x01,
                            Traverse: 0x02,
                            Enter: 0x04,
                            Speak: 0x08,
                            MuteDeafen: 0x10,
                            Move: 0x20,
                            MakeChannel: 0x40,
                            LinkChannel: 0x80,
                            Whisper: 0x100,
                            TextMessage: 0x200,
                            MakeTempChannel: 0x400,

                            // Root only
                            Kick: 0x10000,
                            Ban: 0x20000,
                            Register: 0x40000,
                            SelfRegister: 0x80000,

                            Cached: 0x8000000,
                            All: 0xf07ff
                        });
                        connection.sendMessage('PermissionQuery', {
                            channelId: 0,
                            permissions: permissions,
                            flush: true
                        }); */

      // All: 0xf07ff

      _.each(Users.users, (item, key, list) => {
        connection.sendMessage('UserState', item);
      });

      Users.emit('broadcast', 'UserState', Users.getUser(uid), uid);

      connection.sendMessage('ServerSync', {
        session: Users.getUser(uid).session,
        maxBandwidth: serverConfig.bandwidth,
        welcomeText: serverConfig.welcometext,
        permissions: {
          low: 134217738,
          high: 0,
          unsigned: true,
        },
      });

      connection.sendMessage('ServerConfig', {
        maxBandwidth: null,
        welcomeText: null,
        allowHtml: true,
        messageLength: serverConfig.textmessagelength,
        imageMessageLength: 1131072,
      });

      connection.sendMessage('SuggestConfig', {
        version: 66052,
        positional: null,
        pushToTalk: null,
      });
    });

    connection.on('channelRemove', (m) => {
      Users.emit('broadcast', 'ChannelRemove', {
        channelId: m.channelId,
      });
    });

    connection.on('ping', (m) => {
      connection.sendMessage('Ping', { timestamp: m.timestamp });
    });
  }).listen(serverConfig.port);

  const serverUdp = dgram.createSocket('udp4');

  serverUdp.on('listening', () => {
    const address = serverUdp.address();
  });

  serverUdp.on('message', (message, remote) => {
    if (message.length !== 12) {
      return;
    }

    const q = BufferPack.unpack('>id', message, 0);

    const buffer = BufferPack.pack('>idiii', [0x00010204, q[1], Object.keys(Users.users).length, 5, 128000]);

    serverUdp.send(buffer, 0, buffer.length, remote.port, remote.address, (err, bytes) => {
      if (err) {
        throw err;
      }
    });
  });

  serverUdp.bind(serverConfig.port);
}

startServer(1)
  .catch((e) => {
    console.log(e);
    process.exit();
  });
