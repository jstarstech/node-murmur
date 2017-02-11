
"use strict";

var MumbleConnection = require('./lib/MumbleConnection');
var MumbleSocket = require('./lib/MumbleSocket');
// var User = require('./lib/User');
var tls = require('tls');
var fs = require('fs');
var os = require('os');
var sqlite3 = require('sqlite3').verbose();
var db = new sqlite3.Database('./mumble-server.sqlite');
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
            console.log(err);
            return;
        }

        rows.forEach(function (row, i) {
            if (/^\d+$/.test(row.value)) {
                row.value = parseInt(row.value);
            }
            if (row.value == 'true' || row.value == 'false') {
                row.value = (row.value === 'true');
            }
            server[row.key] = row.value;
        });

        if (typeof server.port == 'undefined') {
            server.port = 64761;
        }

        start()
    });

    var muser = new user({});

    function start() {
        var options = {
            // Private key of the server
            key: server.key,
            // Public key of the server (certificate key)
            cert: server.certificate,
            // Request a certificate from a connecting client
            requestCert: server.certrequired,
            // Automatically reject clients with invalide certificates.
            rejectUnauthorized: false
        };

        // Start a TCP Server
        tls.createServer(options, function (socket) {
            console.log("TLS Client authorized:", socket.authorized);
            if (!socket.authorized) {
                console.log("TLS authorization error:", socket.authorizationError);
            }

            var uid;
            var connection = new MumbleConnection(socket, {});

            var boadcast_listener = function broadcast(type, message, sender_uid) {
                if (sender_uid != uid) {
                    connection.sendMessage(type, message);
                }
            };

            muser.on('broadcast', boadcast_listener);

            var broadcast_audio = function (packet, source_session_id) {
                // Don't want to send it to sender
                if (muser.getUser(uid).session_id === source_session_id) {
                    return;
                }
                if (muser.getUser(uid).self_deaf) {
                    return;
                }

                connection.write(packet);
            };

            muser.on('broadcast_audio', broadcast_audio);

            socket.on('error', function () {
                if (muser.getUser(uid)) {
                    muser.emit('broadcast', 'UserRemove', {session: muser.getUser(uid).session}, uid);
                    muser.deleteUser(uid);
                }
                muser.removeListener('broadcast', boadcast_listener);
                muser.removeListener('broadcast_audio', broadcast_audio);
                connection.disconnect();
            });

            socket.on('close', function () {
                if (muser.getUser(uid)) {
                    muser.emit('broadcast', 'UserRemove', {session: muser.getUser(uid).session}, uid);
                    muser.deleteUser(uid);
                }
                muser.removeListener('broadcast', boadcast_listener);
                muser.removeListener('broadcast_audio', broadcast_audio);
                connection.disconnect();
            });

            connection.on('textMessage', function (m) {
                if (m.channel_id.length) { // A message to the channel
                    var ms = {
                        actor: muser.getUser(uid).session,
                        session: [],
                        channel_id: m.channel_id,
                        tree_id: [],
                        message: m.message
                    };

                    muser.users.forEach(function (row) {
                        if (m.channel_id.indexOf(row.channel_id) > -1 && row.session !== muser.getUser(uid).session) {
                            row.socket.mumble.sendMessage('TextMessage', ms);
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
                    channel_id: m.channel_id,
                    permissions: permissions,
                    flush: false
                });
            });

            connection.on('userState', function (m) {
                muser.updateUser(uid, m);

                connection.sendMessage('UserState', muser.getUser(uid));
                muser.emit('broadcast', 'UserState', muser.getUser(uid), uid);
            });

            connection.sendMessage('Version', {
                version: util.encodeVersion(1, 2, 4),
                release: '1.2.4-0.1' + os.platform(),
                os: os.platform(),
                os_version: os.release()
            });

            connection.on('version', function (m) {
            });
            connection.on('cryptSetup', function (m) {
            });

            connection.on('authenticate', function (m) {
                var auser = {
                    name: m.username,
                    hash: socket.getPeerCertificate().fingerprint.replace(/\:/g, ''),
                    channel_id: server.defaultchannel
                };

                uid = muser.addUser(auser);

                //connection.sendMessage('Reject', { reason: 'omg test'});

                connection.sendMessage('CryptSetup', {
                    key: new Buffer('08dvzUdMpExPo9KUxgVYwg==', 'base64'),
                    client_nonce: new Buffer('vL2nJU/FURMQIu0HF0XlOA==', 'base64'),
                    server_nonce: new Buffer('KhXfffcCF/+WGd8YojVbSQ==', 'base64')
                });

                db.all("SELECT * FROM channels WHERE server_id = $server_id", {
                    $server_id: server_id
                }, function (err, rows) {
                    if (err) {
                        console.log(err);
                        return;
                    }

                    rows.forEach(function(row) {
                        if (row.channel_id == 0) {
                            row.parent_id = null;
                        }
                        connection.sendMessage('ChannelState', {
                            channel_id: row.channel_id,
                            parent: row.parent_id,
                            name: row.name
                        });
                        connection.sendMessage('PermissionQuery', {
                            channel_id: row.channel_id,
                            permissions: 134742798,
                            flush: false
                        });
                    });

                    connection.sendMessage('UserState', muser.getUser(uid));

                    muser.users.forEach(function (row) {
                        if (row.session !== (muser.getUser(uid).session + 100)) {
                            connection.sendMessage('UserState', row);
                        }
                    });

                    muser.emit('broadcast', 'UserState', muser.getUser(uid), uid);

                    connection.sendMessage('ServerSync', {
                        session: muser.getUser(uid).session,
                        max_bandwidth: server.bandwidth,
                        welcome_text: server.welcometext,
                        permissions: {
                            "low": 134742798,
                            "high": 0,
                            "unsigned": true
                        }
                    });

                    connection.sendMessage('ServerConfig', {
                        max_bandwidth: null,
                        welcome_text: null,
                        allow_html: true,
                        message_length: server.textmessagelength,
                        image_message_length: 1131072
                    });

                    connection.sendMessage('SuggestConfig', {
                        version: 66052,
                        positional: null,
                        push_to_talk: null
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
                broadcast1('TextMessage', ms);
            });
        });

        http.listen(64762, function () {
            console.log('listening on *:64762');
        });
    }
}

start_server(1);
