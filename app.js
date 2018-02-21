
"use strict";

let log4js = require('log4js');
let log4js_extend = require("log4js-extend");
log4js.configure('./config/log4js.json');
log4js_extend(log4js, {
    path: __dirname,
    format: "at @name (@file:@line:@column)"
});
let log = log4js.getLogger();

let MumbleConnection = require('./lib/MumbleConnection');
// let User = require('./lib/User');

let async = require('async');
let tls = require('tls');
let os = require('os');
let sqlite3 = require('sqlite3').verbose();
let db = new sqlite3.Database('./db/mumble-server.sqlite');
let util = require('./lib/util');
let user = require('./lib/User');
let bufferpack = require('bufferpack');
let _ = require('underscore');

async function getChannels(server_id, callback) {
    let channels = {};

    let rows = await new Promise(function (resolve) {
        db.all("SELECT * FROM channels WHERE server_id = $server_id", {
            $server_id: server_id
        }, function (err, rows) {
            if (err) {
                log.error(new Error(err));

                return resolve([]);
            }

            rows.forEach(function (row) {
                channels[row.channel_id] = row;
            });

            resolve(rows);
        });
    });

    await async.eachOfLimit(rows, 1, function (channel, key, cb_row) {
        db.all("SELECT * FROM channel_info WHERE server_id = $server_id AND channel_id = $channel_id", {
            $server_id: server_id,
            $channel_id: channel.channel_id
        }, function (err, rows) {
            if (err) {
                log.error(new Error(err));
                return cb_row(err);
            }

            rows.forEach(function (row) {
                if (row.key === 0) {
                    channels[channel.channel_id].description = row.value;
                }
                if (row.key === 1) {
                    channels[channel.channel_id].position = row.value;
                }
            });

            cb_row();
        });
    });

    return channels;
}

async function start_server(server_id) {
    let server = {};

    const rows_config = await new Promise(function (resolve) {
        db.all("SELECT * FROM config WHERE server_id = $server_id", {
            $server_id: server_id
        }, function (err, rows) {
            if (err) {
                log.error(new Error(err));
                return;
            }

            resolve(rows)
        });
    });

    rows_config.forEach(function (row, i) {
        if (/^\d+$/.test(row.value)) {
            row.value = parseInt(row.value);
        }

        if (row.value === 'true' || row.value === 'false') {
            row.value = (row.value === 'true');
        }
        server[row.key] = row.value;
    });

    if (typeof server.port === 'undefined') {
        server.port = 64738;
    }

    let channels = await getChannels(1);

    let Users = new user();

    let options = {
        key: server.key,
        cert: server.certificate,
        requestCert: server.certrequired,
        rejectUnauthorized: false
    };

    tls.createServer(options, function (socket) {
        log.info("TLS Client authorized:", socket.authorized);
        if (!socket.authorized) {
            log.info("TLS authorization error:", socket.authorizationError);
        }

        let uid;
        let connection = new MumbleConnection(socket, Users);

        function boadcast_listener(type, message, sender_uid) {
            if (type !== 'UserState' && sender_uid === uid) {
                return;
            }

            if (type === 'TextMessage' && message.channelId.indexOf(Users.getUser(uid).channelId) === -1) {
                return;
            }

            connection.sendMessage(type, message);
        }

        Users.on('broadcast', boadcast_listener);

        function broadcast_audio(packet, source_session) {
            let user = Users.getUser(uid);

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

        Users.on('broadcast_audio', broadcast_audio);

        connection.on('error', function (err) {
            log.info('User disconnected', err);
        });

        connection.on('disconnect', function () {
            log.info('User disconnected');

            if (Users.getUser(uid)) {
                Users.emit('broadcast', 'UserRemove', {session: Users.getUser(uid).session}, uid);
                Users.deleteUser(uid);
            }
            Users.removeListener('broadcast', boadcast_listener);
            Users.removeListener('broadcast_audio', broadcast_audio);
        });

        connection.on('textMessage', function (m) {
            if (m.channelId.length === 0) {
                return;
            }

            let ms = {
                actor: Users.getUser(uid).session,
                session: [],
                channelId: m.channelId,
                treeId: [],
                message: m.message
            };

            Users.emit('broadcast', 'TextMessage', ms, uid);
        });

        connection.on('permissionQuery', function (m) {
            let permissions = util.writePermissions({
                Write: 0x01,
                Traverse: 0x02,
                Enter: 0x04,
                Speak: 0x08,
                Whisper: 0x100,
                TextMessage: 0x200
            });

            connection.sendMessage('PermissionQuery', {
                channelId: m.channelId,
                permissions: permissions,
                flush: false
            });
        });

        connection.on('userState', function (m) {
            let user = Users.getUser(uid);

            let update_user_state = {
                session: user.session,
                actor: user.session
            };

            if (m.hasOwnProperty('deaf') && m.deaf !== user.deaf) {
                update_user_state.deaf = m.deaf;
            }

            if (m.hasOwnProperty('mute') && m.mute !== user.mute) {
                update_user_state.mute = m.mute;
            }

            if (m.hasOwnProperty('recording') && m.recording !== user.recording) {
                update_user_state.recording = m.recording;
            }

            if (m.hasOwnProperty('suppress') && m.suppress !== user.suppress) {
                update_user_state.suppress = m.suppress;
            }

            if (m.hasOwnProperty('selfMute') && m.selfMute !== user.selfMute) {
                update_user_state.selfMute = m.selfMute;
            }

            if (m.hasOwnProperty('selfDeaf') && m.selfDeaf !== user.selfDeaf) {
                update_user_state.selfDeaf = m.selfDeaf;
            }

            if (m.hasOwnProperty('channelId') && m.channelId !== user.channelId) {
                update_user_state.channelId = m.channelId;
            }

            if (m.hasOwnProperty('prioritySpeaker') && m.prioritySpeaker !== user.prioritySpeaker) {
                update_user_state.prioritySpeaker = m.prioritySpeaker;
            }

            if (m.hasOwnProperty('pluginIdentity') && m.pluginIdentity !== user.pluginIdentity) {
                update_user_state.pluginIdentity = m.pluginIdentity;
            }

            if (m.hasOwnProperty('pluginContext') && m.pluginContext !== user.pluginContext) {
                update_user_state.pluginContext = m.pluginContext;
            }

            Users.updateUser(uid, update_user_state);

            Users.emit('broadcast', 'UserState', update_user_state, uid);
        });

        connection.sendMessage('Version', {
            version: util.encodeVersion(1, 2, 4),
            release: '1.2.4-0.1' + os.platform(),
            os: os.platform(),
            osVersion: os.release()
        });

        connection.on('authenticate', function (m) {
            uid = Users.addUser({
                name: m.username,
                hash: socket.getPeerCertificate().fingerprint.replace(/:/g, '').toLowerCase(),
                channelId: server.defaultchannel
            });

            connection.sessionId = Users.getUser(uid).session;

            // connection.sendMessage('Reject', { reason: 'omg test'});
            // return;

            connection.sendMessage('CryptSetup', {
                key: new Buffer('08dvzUdMpExPo9KUxgVYwg==', 'base64'),
                clientNonce: new Buffer('vL2nJU/FURMQIu0HF0XlOA==', 'base64'),
                serverNonce: new Buffer('KhXfffcCF/+WGd8YojVbSQ==', 'base64')
            });

            connection.sendMessage('CodecVersion', {
                alpha: -2147483637,
                beta: 0,
                preferAlpha: true,
                opus: true
            });

            _.each(channels, function (channel, key, list) {
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
                    descriptionHash: null
                });
            });

            connection.sendMessage('PermissionQuery', {
                channelId: 0,
                permissions: 134742798,
                flush: false
            });

            _.each(Users.users, function (item, key, list) {
                connection.sendMessage('UserState', item);
            });

            Users.emit('broadcast', 'UserState', Users.getUser(uid), uid);

            connection.sendMessage('ServerSync', {
                session: Users.getUser(uid).session,
                maxBandwidth: server.bandwidth,
                welcomeText: server.welcometext,
                permissions: {
                    low: 134217738,
                    high: 0,
                    unsigned: true
                }
            });

            connection.sendMessage('ServerConfig', {
                maxBandwidth: null,
                welcomeText: null,
                allowHtml: true,
                messageLength: server.textmessagelength,
                imageMessageLength: 1131072
            });

            connection.sendMessage('SuggestConfig', {
                version: 66052,
                positional: null,
                pushToTalk: null
            });
        });
        connection.on('ping', function (m) {
            connection.sendMessage('Ping', {timestamp: m.timestamp});
        });
    }).listen(server.port);

    let dgram = require('dgram');
    let server_udp = dgram.createSocket('udp4');

    server_udp.on('listening', function () {
        let address = server_udp.address();
    });

    server_udp.on('message', function (message, remote) {
        if (message.length !== 12) {
            return;
        }

        let q = bufferpack.unpack('>id', message, 0);

        let buffer = bufferpack.pack(">idiii", [0x00010204, q[1], Object.keys(Users.users).length, 5, 128000]);

        server_udp.send(buffer, 0, buffer.length, remote.port, remote.address, function (err, bytes) {
            if (err) {
                throw err;
            }
        });
    });

    server_udp.bind(server.port);

    let app = require('express')();
    let http = require('http').Server(app);
    let io = require('socket.io')(http);

    app.get('/', function (req, res) {
        res.sendFile(__dirname + '/index.html');
    });

    io.on('connection', function (socket) {
        socket.on('chat message', function (msg) {
            io.emit('chat message', msg);
            let ms = {
                //actor: users[user].u.session,
                session: [],
                //channelId: m.channelId,
                tree_id: [],
                message: msg
            };

            Users.emit('broadcast', 'TextMessage', ms, 0);
        });
    });

    http.listen(64739, function () {
        log.info('listening on *:64738');
    });
}

start_server(1);
