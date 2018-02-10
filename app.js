
"use strict";

var log4js = require('log4js');
var log4js_extend = require("log4js-extend");
log4js.configure('./config/log4js.json');
log4js_extend(log4js, {
    path: __dirname,
    format: "at @name (@file:@line:@column)"
});
var log = log4js.getLogger();

var MumbleConnection = require('./lib/MumbleConnection');
// var User = require('./lib/User');

var tls = require('tls');
var os = require('os');
var sqlite3 = require('sqlite3').verbose();
var db = new sqlite3.Database('./db/mumble-server.sqlite');
var util = require('./lib/util');
var user = require('./lib/User');
var bufferpack = require('bufferpack');

function start_server(server_id) {
    var clients = [];
    var channels = [];
    var server = {};

    db.all("SELECT * FROM config WHERE server_id = $server_id", {
        $server_id: server_id
    }, function (err, rows) {
        if (err) {
            log.error(err);
            return;
        }

        rows.forEach(function (row, i) {
            if (/^\d+$/.test(row.value)) {
                row.value = parseInt(row.value);
            }

            if (row.value === 'true' || row.value === 'false') {
                row.value = (row.value === 'true');
            }
            server[row.key] = row.value;
        });

        if (typeof server.port === 'undefined') {
            server.port = 64761;
        }

        start()
    });

    function start() {
        var muser = new user({});
        setInterval(function () {
            muser.users.forEach(function (i) {
                 // log.info(i);
            })
        }, 2000);

        var options = {
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

            var uid;
            var connection = new MumbleConnection(socket);

            var boadcast_listener = function (type, message, sender_uid) {
                connection.sendMessage(type, message);
                if (sender_uid !== uid) {
                    connection.sendMessage(type, message);
                }
            };

            muser.on('broadcast', boadcast_listener);

            var broadcast_audio = function (packet, source_session_id) {
                if (muser.getUser(uid).session_id === source_session_id) {
                    return;
                }
                if (muser.getUser(uid).self_deaf) {
                    return;
                }

                connection.write(packet);
            };

            muser.on('broadcast_audio', broadcast_audio);

            connection.on('error', function () {
                if (muser.getUser(uid)) {
                    muser.emit('broadcast', 'UserRemove', {session: muser.getUser(uid).session}, uid);
                    muser.deleteUser(uid);
                }
                muser.removeListener('broadcast', boadcast_listener);
                muser.removeListener('broadcast_audio', broadcast_audio);
                connection.disconnect();
            });

            connection.on('disconnect', function () {
                log.info('User disconnected');

                if (muser.getUser(uid)) {
                    muser.emit('broadcast', 'UserRemove', {session: muser.getUser(uid).session}, uid);
                    muser.deleteUser(uid);
                }
                muser.removeListener('broadcast', boadcast_listener);
                muser.removeListener('broadcast_audio', broadcast_audio);
            });

            connection.on('textMessage', function (m) {
                if (m.channel_id.length) { // A message to the channel
                    var ms = {
                        actor: muser.getUser(uid).session,
                        session: [],
                        channel_id: m.channel_id,
                        treeId: [],
                        message: m.message
                    };

                    muser.users.forEach(function (row) {
                        if (m.channel_id.indexOf(row.channel_id) > -1 && row.session !== muser.getUser(uid).session) {
                            muser.emit('broadcast', 'TextMessage', ms, uid);
                        }
                    });
                }
            });

            connection.on('permissionQuery', function (m) {
                var permissions = util.writePermissions({
                    Write: 0x01,
                    Traverse: 0x02,
                    Enter: 0x04,
                    Speak: 0x08,
                    Whisper: 0x100,
                    TextMessage: 0x200
                });

                connection.sendMessage('PermissionQuery', {
                    channelId: m.channel_id,
                    permissions: permissions,
                    flush: false
                });
            });

            connection.on('userState', function (m) {
                if (m.selfMute) {
                    m.self_mute = m.selfMute;
                    delete m['selfMute'];
                }
                if (m.selfDeaf) {
                    m.self_deaf = m.selfDeaf;
                    delete m['selfMute'];
                }

                muser.updateUser(uid, m);

                muser.emit('broadcast', 'UserState', m, uid);
            });

            connection.sendMessage('Version', {
                version: util.encodeVersion(1, 2, 4),
                release: '1.2.4-0.1' + os.platform(),
                os: os.platform(),
                osVersion: os.release()
            });

            connection.on('authenticate', function (m) {
                uid = muser.addUser({
                    name: m.username,
                    hash: socket.getPeerCertificate().fingerprint.replace(/\:/g, ''),
                    channel_id: server.defaultchannel
                });

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

                db.all("SELECT * FROM channels WHERE server_id = $server_id", {
                    $server_id: server_id
                }, function (err, rows) {
                    if (err) {
                        log.error(err);
                        return;
                    }

                    rows.forEach(function(row) {
                        connection.sendMessage('ChannelState', {
                            channelId: row.channel_id,
                            parent: row.parent_id,
                            name: row.name,
                            links: [],
                            description: null,
                            linksAdd: [],
                            linksRemove: [],
                            temporary: false,
                            position: 0,
                            descriptionHash: null
                        });
                    });

                    connection.sendMessage('PermissionQuery', {
                        channelId: 0,
                        permissions: 134742798,
                        flush: false
                    });

                    // connection.sendMessage('UserState', muser.getUser(uid));
                    // muser.emit('broadcast', 'UserState', muser.getUser(uid), uid);

                    muser.users.forEach(function (row) {
                        connection.sendMessage('UserState', row);
                    });

                    connection.sendMessage('ServerSync', {
                        session: muser.getUser(uid).session,
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
            });
            connection.on('ping', function (m) {
                connection.sendMessage('Ping', {timestamp: m.timestamp});
            });
        }).listen(server.port);

        var dgram = require('dgram');
        var server_udp = dgram.createSocket('udp4');

        server_udp.on('listening', function () {
            var address = server_udp.address();
        });

        server_udp.on('message', function (message, remote) {
            if (message.length !== 12) {
                return;
            }

            var q = bufferpack.unpack('>id', message, 0);

            var buffer = bufferpack.pack(">idiii", [0x00010204, q[1], clients.length, 5, 128000]);

            server_udp.send(buffer, 0, buffer.length, remote.port, remote.address, function (err, bytes) {
                if (err) {
                    throw err;
                }
            });
        });

        server_udp.bind(server.port);

        var app = require('express')();
        var http = require('http').Server(app);
        var io = require('socket.io')(http);

        app.get('/', function (req, res) {
            res.sendFile(__dirname + '/index.html');
        });

        // Send a message to all clients
        function broadcast1(type, message) {
            clients.forEach(function (client) {
                client.mumble.sendMessage(type, message);
            });
        }

        io.on('connection', function (socket) {
            socket.on('chat message', function (msg) {
                io.emit('chat message', msg);
                var ms = {
                    //actor: users[user].u.session,
                    session: [],
                    //channel_id: m.channel_id,
                    tree_id: [],
                    message: msg
                };

                muser.emit('broadcast', 'TextMessage', ms, 0);
            });
        });

        http.listen(64762, function () {
            log.info('listening on *:64762');
        });
    }
}

start_server(1);
