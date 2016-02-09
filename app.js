
"use strict";

var MumbleConnection = require('./lib/MumbleConnection');
var MumbleSocket = require('./lib/MumbleSocket');
var tls = require('tls');
var fs = require('fs');
var sqlite3 = require('sqlite3').verbose();
var db = new sqlite3.Database('./mumble-server.sqlite');
var util = require('./lib/util');
var bufferpack = require('bufferpack');

function start_server(server_id) {
    var users = [];
    var clients = [];
    var server = {};

    db.all("SELECT * FROM config WHERE server_id = $server_id", {
        $server_id: 1
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

        start()
    });

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

            var user;

            /*console.log("Cipher: ",  socket.getCipher());
             console.log("Address: ", socket.address());
             console.log("Remote address: ", socket.remoteAddress);
             console.log("Remote port: ", socket.remotePort);*/
            //console.log("getPeerCertificate: ", socket.getPeerCertificate().fingerprint.replace(/\:/g, ''));

            var connection = new MumbleConnection(socket, {});

            socket.name = socket.remoteAddress + ":" + socket.remotePort;
            socket.mumble = connection;
            clients.push(socket);

            // Send a message to all clients
            function broadcast(type, message, sender) {
                clients.forEach(function (client) {
                    // Don't want to send it to sender
                    if (client === sender) {
                        return;
                    }

                    client.mumble.sendMessage(type, message);
                });
            }

            // Send a message to all clients
            var broadcast_audio = function (packet, source_session_id) {
                clients.forEach(function (client) {
                    // Don't want to send it to sender
                    if (client.mumble.session_id === source_session_id) {
                        return;
                    }

                    client.write(packet);
                });
            };

            socket.on('error', function () {
                broadcast('UserRemove', {session: users[user].u.session}, socket);
                delete users[user];
                user = false;
                clients.splice(clients.indexOf(socket), 1);
                connection.disconnect();
            });

            socket.on('close', function () {
                broadcast('UserRemove', {session: users[user].u.session}, socket);
                delete users[user];
                user = false;
                clients.splice(clients.indexOf(socket), 1);
                connection.disconnect();
            });

            connection.on('textMessage', function (m) {
                if (m.channel_id.length) { // A message to the channel
                    var ms = {
                        actor: users[user].u.session,
                        session: [],
                        channel_id: m.channel_id,
                        tree_id: [],
                        message: m.message
                    };

                    users.forEach(function (row) {
                        if (m.channel_id.indexOf(row.u.channel_id) > -1 && row.u.session !== (user + 100)) {
                            row.socket.mumble.sendMessage('TextMessage', ms);
                        }
                    });
                }
            });

            connection.on('permissionQuery', function (m) {
                console.log(m);
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
                var u = {
                    actor: users[user].u.session,
                    session: users[user].u.session
                };

                if (m.actor != null) {
                    u.actor = m.actor;
                    users[user].u.actor = m.actor;
                }
                if (m.name != null) {
                    u.name = m.name;
                    users[user].u.name = m.name;
                }
                if (m.user_id != null) {
                    u.user_id = m.user_id;
                    users[user].u.user_id = m.user_id;
                }
                if (m.deaf != null) {
                    u.deaf = m.deaf;
                    users[user].u.deaf = m.deaf;
                }
                if (m.mute != null) {
                    u.mute = m.mute;
                    users[user].u.mute = m.mute;
                }
                if (m.recording != null) {
                    u.recording = m.recording;
                    users[user].u.recording = m.recording;
                }
                if (m.suppress != null) {
                    u.suppress = m.suppress;
                    users[user].u.suppress = m.suppress;
                }
                if (m.self_mute != null) {
                    u.self_mute = m.self_mute;
                    users[user].u.self_mute = m.self_mute;
                }
                if (m.self_deaf != null) {
                    u.self_deaf = m.self_deaf;
                    users[user].u.self_deaf = m.self_deaf;
                }
                if (m.channel_id != null) {
                    u.channel_id = m.channel_id;
                    users[user].u.channel_id = m.channel_id;
                }
                if (m.priority_speaker != null) {
                    u.priority_speaker = m.priority_speaker;
                    users[user].u.priority_speaker = m.priority_speaker;
                }
                if (m.texture_hash != null) {
                    u.texture_hash = m.texture_hash;
                    users[user].u.texture_hash = m.texture_hash;
                }
                if (m.comment_hash != null) {
                    u.comment_hash = m.comment_hash;
                    users[user].u.comment_hash = m.comment_hash;
                }
                if (m.hash != null) {
                    u.hash = m.hash;
                    users[user].u.hash = m.hash;
                }
                if (m.comment != null) {
                    u.comment = m.comment;
                    users[user].u.comment = m.comment;
                }
                if (m.plugin_identity != null) {
                    u.plugin_identity = m.plugin_identity;
                    users[user].u.plugin_identity = m.plugin_identity;
                }
                if (m.plugin_context != null) {
                    u.plugin_context = m.plugin_context;
                    users[user].u.plugin_context = m.plugin_context;
                }
                if (m.texture != null) {
                    u.texture = m.texture;
                    users[user].u.texture = m.texture;
                }

                connection.sendMessage('UserState', u);

                broadcast('UserState', u, socket);
            });

            connection.sendMessage('Version', {
                version: util.encodeVersion(1, 2, 4),
                release: 'Node.js-client',
                os: 'Node.js',
                os_version: process.version
            });

            connection.on('version', function (m) {
            });
            connection.on('cryptSetup', function (m) {
            });

            connection.on('authenticate', function (m) {
                var nuser = {u: {}};
                var new_session = users.push(nuser);
                new_session--;

                user = new_session;
                users[user].socket = socket;
                users[user].u.name = m.username;
                users[user].u.session = new_session + 100;
                users[user].u.recording = null;
                users[user].u.mute = null;
                users[user].u.deaf = null;
                users[user].u.self_mute = null;
                users[user].u.self_deaf = null;
                users[user].u.suppress = null;
                users[user].u.priority_speaker = null;
                users[user].u.hash = socket.getPeerCertificate().fingerprint.replace(/\:/g, '');
                users[user].u.channel_id = 30;

                connection.broadcast_audio = broadcast_audio;
                connection.session_id = users[user].u.session;

                //connection.sendMessage('Reject', { reason: 'omg test'});

                connection.sendMessage('CryptSetup', {
                    key: new Buffer('08dvzUdMpExPo9KUxgVYwg==', 'base64'),
                    client_nonce: new Buffer('vL2nJU/FURMQIu0HF0XlOA==', 'base64'),
                    server_nonce: new Buffer('KhXfffcCF/+WGd8YojVbSQ==', 'base64')
                });

                db.each("SELECT * FROM channels WHERE server_id=1", function (err, row) {
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
                }, function (err, num_row) {
                    connection.sendMessage('UserState', users[user].u);

                    users.forEach(function (row) {
                        connection.sendMessage('UserState', row.u);
                        if (row.u.session !== (user + 100)) {
                            connection.sendMessage('UserState', row.u);
                        }
                    });

                    broadcast('UserState', users[user].u, socket);

                    connection.sendMessage('ServerSync', {
                        session: users[user].u.session,
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
                        message_length: 5000,
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
        }).listen(64760);

        var PORT = 64760;
        var HOST = '0.0.0.0';

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

        server_udp.bind(PORT);


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

        http.listen(64761, function () {
            console.log('listening on *:3000');
        });
    }
}
start_server(1);
