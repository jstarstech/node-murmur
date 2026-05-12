import dgram from 'dgram';
import crypto from 'crypto';
import tls from 'tls';
import os from 'os';
import { fileURLToPath } from 'url';
import _ from 'underscore';
import BufferPack from 'bufferpack';
import log4js from 'log4js';
import * as util from './lib/util.js';
import MumbleConnection from './lib/MumbleConnection.js';
import User from './lib/User.js';
import { buildAclResponse, canEnterChannel, computePermissions, loadAclState, PERMISSIONS } from './lib/Acl.js';
import CryptState from './lib/CryptState.js';
import { getVoiceKind, getVoiceTarget, rebuildVoicePacket } from './lib/voice.js';
import Config from './models/config.js';
import Channels from './models/channels.js';
import ChannelInfo from './models/channel_info.js';

log4js.configure(fileURLToPath(new URL('../config/log4js.json', import.meta.url)));
const log = log4js.getLogger();

async function getChannels(server_id) {
    const channels = {};

    const dbChannels = await Channels.findAll({
        where: {
            server_id
        }
    }).catch(err => {
        log.error(new Error(err));

        return [];
    });

    for (const dbChannel of dbChannels) {
        channels[dbChannel.channel_id] = dbChannel;

        const channelInfos = await ChannelInfo.findAll({
            where: {
                server_id,
                channel_id: dbChannel.channel_id
            }
        }).catch(err => {
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

    if (!channels[0]) {
        channels[0] = {
            channel_id: 0,
            parent_id: null,
            name: 'Root',
            description: '',
            position: '0'
        };
    }

    return channels;
}

function sendChannelState(connection, channel) {
    const description = channel.description || '';
    const descriptionBuffer = Buffer.from(description);
    const shouldSendHash = descriptionBuffer.length >= 128 && (connection.clientVersion || 0) >= 0x10202;

    connection.sendMessage('ChannelState', {
        channelId: channel.channel_id,
        parent: channel.parent_id,
        name: channel.name,
        links: [],
        linksAdd: [],
        linksRemove: [],
        temporary: false,
        position: channel.position || '0',
        description: shouldSendHash ? '' : description,
        descriptionHash: shouldSendHash ? crypto.createHash('sha1').update(descriptionBuffer).digest() : null
    });
}

async function startServer(server_id) {
    const serverConfig = {};

    const dbConfigs = await Config.findAll({
        where: {
            server_id
        }
    }).catch(err => {
        log.error(new Error(err));

        return [];
    });

    for (const dbConfig of dbConfigs) {
        if (/^\d+$/.test(dbConfig.value)) {
            dbConfig.value = parseInt(dbConfig.value);
        }

        if (dbConfig.value === 'true' || dbConfig.value === 'false') {
            dbConfig.value = dbConfig.value === 'true';
        }
        serverConfig[dbConfig.key] = dbConfig.value;
    }

    if (typeof serverConfig.port === 'undefined') {
        serverConfig.port = 64738;
    }

    const channels = await getChannels(server_id);
    const aclState = await loadAclState(server_id);

    const Users = new User(log);
    const connectionsBySession = new Map();
    const udpAddrToConnection = new Map();
    let serverUdp;

    function getUdpAddrKey(rinfo) {
        return `${rinfo.address}:${rinfo.port}`;
    }

    function requestCryptResync(connection) {
        if (!connection?.cryptState) {
            return;
        }

        if (!connection.cryptState.shouldRequestResync()) {
            return;
        }

        if (connection.lastCryptResync && Date.now() / 1000 - connection.lastCryptResync < 5) {
            return;
        }

        connection.lastCryptResync = Math.floor(Date.now() / 1000);
        connection.sendMessage('CryptSetup', {});
    }

    function sendVoicePacket(connection, rawPacket, fallbackRinfo) {
        if (connection?.cryptState && connection.udpaddr) {
            try {
                const encrypted = connection.cryptState.encrypt(rawPacket);
                const { address, port } = connection.udpaddr;
                udpAddrToConnection.set(getUdpAddrKey(connection.udpaddr), connection);
                serverUdp.send(encrypted, port, address, err => {
                    if (err) {
                        log.error(new Error(err));
                    }
                });
                return;
            } catch (err) {
                log.error(new Error(err));
            }
        }

        if (connection && typeof connection.sendMessage === 'function') {
            connection.sendMessage('UDPTunnel', { packet: rawPacket });
            return;
        }

        if (fallbackRinfo && serverUdp) {
            serverUdp.send(rawPacket, fallbackRinfo.port, fallbackRinfo.address, err => {
                if (err) {
                    log.error(new Error(err));
                }
            });
        }
    }

    function broadcastVoicePacket(rawPacket, sourceSession) {
        const sourceChannelId = Users.sessionToChannels[sourceSession];
        if (sourceChannelId === undefined || sourceChannelId === null) {
            return;
        }

        const target = getVoiceTarget(rawPacket);
        const sourceConnection = connectionsBySession.get(sourceSession);

        if (target === 31) {
            if (sourceConnection) {
                sendVoicePacket(sourceConnection, rawPacket);
            }
            return;
        }

        for (const user of Object.values(Users.users)) {
            if (!user || user.session === undefined || user.session === null) {
                continue;
            }

            if (user.session === sourceSession) {
                continue;
            }

            if (user.channelId !== sourceChannelId) {
                continue;
            }

            if (user.selfDeaf === true) {
                continue;
            }

            const targetConnection = connectionsBySession.get(user.session);
            if (!targetConnection) {
                continue;
            }

            sendVoicePacket(targetConnection, rawPacket);
        }
    }

    const options = {
        key: serverConfig.key,
        cert: serverConfig.certificate,
        requestCert: serverConfig.certrequired,
        rejectUnauthorized: false
    };

    tls.createServer(options, socket => {
        socket.setKeepAlive(true, 10000);
        socket.setTimeout(10000);
        socket.setNoDelay(true);

        log.info('TLS Client authorized:', socket.authorized);

        if (!socket.authorized) {
            log.info('TLS authorization error:', socket.authorizationError);
        }

        let uid;
        let auth = false;
        let ready = false;
        const connection = new MumbleConnection(socket, Users);
        connection.clientCryptoModes = [];
        connection.lastCryptResync = 0;

        function broadcastListener(type, message, sender_uid) {
            if (sender_uid !== undefined) {
                if (type !== 'UserState' && sender_uid === uid) {
                    return;
                }
            }

            if (type === 'TextMessage' && !message.channelId.includes(Users.getUser(uid).channelId)) {
                return;
            }

            connection.sendMessage(type, message);
        }

        Users.on('broadcast', broadcastListener);

        function broadcastAudio(packet, source_session) {
            broadcastVoicePacket(packet, source_session);
        }

        Users.on('broadcast_audio', broadcastAudio);

        connection.on('error', err => {
            log.info('User disconnected', err);
        });

        connection.on('disconnect', async () => {
            log.info('User disconnected');

            const user = Users.getUser(uid);
            if (user.session) {
                Users.emit('broadcast', 'UserRemove', { session: user.session }, uid);
                connectionsBySession.delete(user.session);
                if (connection.udpaddr) {
                    udpAddrToConnection.delete(getUdpAddrKey(connection.udpaddr));
                }
                await Users.deleteUser(uid);
            }

            Users.removeListener('broadcast', broadcastListener);
            Users.removeListener('broadcast_audio', broadcastAudio);
        });

        connection.on('version', version => {
            connection.clientCryptoModes = Array.isArray(version.cryptoModes) ? version.cryptoModes : [];
            connection.clientVersion = version.version || 0;
        });

        connection.on('textMessage', ({ channelId, message }) => {
            if (channelId.length === 0) {
                return;
            }

            const ms = {
                actor: Users.getUser(uid).session,
                session: [],
                channelId,
                treeId: [],
                message
            };

            Users.emit('broadcast', 'TextMessage', ms, uid);
        });

        connection.on('permissionQuery', m => {
            const requestedChannelId = Number(m.channelId || 0);
            const user = Users.getUser(uid);
            if (!user || user.session === undefined) {
                return;
            }

            const permissions = computePermissions(requestedChannelId, user, channels, aclState);

            connection.sendMessage('PermissionQuery', {
                channelId: requestedChannelId,
                permissions,
                flush: false
            });
        });

        connection.on('acl', m => {
            if (m.query) {
                const requestedChannelId = Number(m.channelId || 0);
                connection.sendMessage('ACL', buildAclResponse(requestedChannelId, channels, aclState));
            }
        });

        let authUserState = {};
        connection.on('userState', async m => {
            const user = Users.getUser(uid);

            const updateUserState = {
                session: user.session || null,
                actor: user.session || null
            };

            if (Object.prototype.hasOwnProperty.call(m, 'deaf') && m.deaf !== user.deaf) {
                updateUserState.deaf = m.deaf;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'mute') && m.mute !== user.mute) {
                updateUserState.mute = m.mute;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'recording') && m.recording !== user.recording) {
                updateUserState.recording = m.recording;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'suppress') && m.suppress !== user.suppress) {
                updateUserState.suppress = m.suppress;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'selfMute') && m.selfMute !== user.selfMute) {
                updateUserState.selfMute = m.selfMute;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'selfDeaf') && m.selfDeaf !== user.selfDeaf) {
                updateUserState.selfDeaf = m.selfDeaf;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'channelId') && m.channelId !== user.channelId) {
                updateUserState.channelId = m.channelId;
            }

            if (
                Object.prototype.hasOwnProperty.call(m, 'prioritySpeaker') &&
                m.prioritySpeaker !== user.prioritySpeaker
            ) {
                updateUserState.prioritySpeaker = m.prioritySpeaker;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'pluginIdentity') && m.pluginIdentity !== user.pluginIdentity) {
                updateUserState.pluginIdentity = m.pluginIdentity;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'pluginContext') && m.pluginContext !== user.pluginContext) {
                updateUserState.pluginContext = m.pluginContext;
            }

            if (
                auth === true &&
                Object.prototype.hasOwnProperty.call(updateUserState, 'channelId') &&
                updateUserState.channelId !== user.channelId
            ) {
                const requestedChannelId = Number(updateUserState.channelId);
                const destinationChannel = channels[requestedChannelId];

                if (!destinationChannel) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: PERMISSIONS.Enter,
                        channelId: requestedChannelId,
                        session: user.session,
                        reason: 'Unknown channel'
                    });
                    return;
                }

                if (!canEnterChannel(requestedChannelId, user, channels, aclState)) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: PERMISSIONS.Enter,
                        channelId: requestedChannelId,
                        session: user.session,
                        reason: 'Permission denied'
                    });
                    return;
                }
            }

            if (auth === false) {
                authUserState = updateUserState;
                return;
            }

            if (ready === false) {
                return;
            } else {
                await Users.updateUser(uid, updateUserState);
            }

            Users.emit('broadcast', 'UserState', updateUserState, uid);
        });

        connection.sendMessage('Version', {
            version: util.encodeVersion(1, 2, 4),
            release: `1.2.4-0.1${os.platform()}`,
            os: os.platform(),
            osVersion: os.release(),
            cryptoModes: CryptState.supportedModes()
        });

        connection.on('authenticate', async m => {
            const peerCertificate = socket.getPeerCertificate();
            const certificateHash =
                peerCertificate && typeof peerCertificate.fingerprint === 'string'
                    ? peerCertificate.fingerprint.replace(/:/g, '').toLowerCase()
                    : null;

            const authResult = await Users.addUser({
                name: m.username,
                password: m.password,
                opus: m.opus,
                hash: certificateHash,
                channelId: serverConfig.defaultchannel
            });

            if (authResult.reject) {
                connection.sendMessage('Reject', authResult.reject);
                connection.disconnect();
                return;
            }

            uid = authResult.id;

            delete authUserState.channelId;
            await Users.updateUser(uid, authUserState);
            auth = true;

            connection.sessionId = Users.getUser(uid).session;
            connectionsBySession.set(connection.sessionId, connection);

            const negotiatedMode =
                connection.clientCryptoModes.find(mode => CryptState.supportedModes().includes(mode)) ||
                CryptState.supportedModes()[0];
            connection.cryptState = new CryptState(negotiatedMode);
            connection.cryptState.generateKey(negotiatedMode);

            connection.sendMessage('CryptSetup', connection.cryptState.getCryptSetup());

            connection.sendMessage('CodecVersion', {
                alpha: -2147483637,
                beta: 0,
                preferAlpha: true,
                opus: true
            });

            const rootChannel = channels[0];
            sendChannelState(connection, rootChannel);

            _.each(
                Object.values(channels)
                    .filter(channel => channel.channel_id !== 0)
                    .sort((left, right) => left.channel_id - right.channel_id),
                channel => {
                    sendChannelState(connection, channel);
                }
            );

            _.each(Users.users, item => {
                if (item.session === connection.sessionId) {
                    return;
                }

                if (!connectionsBySession.has(item.session)) {
                    return;
                }

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
                    unsigned: true
                }
            });

            connection.sendMessage('ServerConfig', {
                maxBandwidth: null,
                welcomeText: null,
                allowHtml: true,
                messageLength: serverConfig.textmessagelength,
                imageMessageLength: 1131072
            });

            connection.sendMessage('SuggestConfig', {
                version: 66052,
                positional: null,
                pushToTalk: null
            });

            ready = true;
        });

        connection.on('channelRemove', ({ channelId }) => {
            Users.emit('broadcast', 'ChannelRemove', {
                channelId
            });
        });

        connection.on('ping', m => {
            const { timestamp } = m;
            if (connection.cryptState) {
                connection.cryptState.markRemoteStats(m);
                connection.sendMessage('Ping', connection.cryptState.buildPingResponse(timestamp));
                return;
            }

            connection.sendMessage('Ping', {
                timestamp,
                good: m.good,
                late: m.late,
                lost: m.lost,
                resync: m.resync,
                udpPackets: m.udpPackets,
                tcpPackets: m.tcpPackets,
                udpPingAvg: m.udpPingAvg,
                udpPingVar: m.udpPingVar,
                tcpPingAvg: m.tcpPingAvg,
                tcpPingVar: m.tcpPingVar
            });
        });

        connection.on('cryptSetup', msg => {
            if (!connection.cryptState) {
                return;
            }

            try {
                const response = connection.cryptState.handleCryptSetup(msg);
                if (response) {
                    connection.sendMessage('CryptSetup', response);
                }
            } catch (err) {
                log.error(new Error(err));
            }
        });
    }).listen(serverConfig.port);

    serverUdp = dgram.createSocket('udp4');

    serverUdp.on('listening', () => {
        // const address = serverUdp.address();;
    });

    serverUdp.on('message', (message, rinfo) => {
        if (message.length === 12) {
            const q = BufferPack.unpack('>id', message, 0);

            const buffer = BufferPack.pack('>idiii', [0x00010204, q[1], Object.keys(Users.users).length, 5, 128000]);

            serverUdp.send(buffer, 0, buffer.length, rinfo.port, rinfo.address, err => {
                if (err) {
                    throw err;
                }
            });
            return;
        }

        const addrKey = getUdpAddrKey(rinfo);
        const mappedConnection = udpAddrToConnection.get(addrKey);
        const candidates = [];

        if (mappedConnection) {
            candidates.push({ connection: mappedConnection, requestResync: true });
        }

        for (const connection of connectionsBySession.values()) {
            if (connection === mappedConnection) {
                continue;
            }

            candidates.push({ connection, requestResync: false });
        }

        let matchedConnection = null;
        let plain = null;

        for (const { connection, requestResync } of candidates) {
            if (!connection?.cryptState) {
                continue;
            }

            try {
                plain = connection.cryptState.decrypt(message);
                matchedConnection = connection;
                break;
            } catch {
                if (requestResync) {
                    requestCryptResync(connection);
                }
            }
        }

        if (!matchedConnection || !plain) {
            return;
        }

        matchedConnection.udpaddr = rinfo;
        udpAddrToConnection.set(addrKey, matchedConnection);

        const kind = getVoiceKind(plain);

        if (kind === 1) {
            sendVoicePacket(matchedConnection, plain, rinfo);
            return;
        }

        const voicePacket = rebuildVoicePacket(matchedConnection.sessionId, plain);
        if (!voicePacket) {
            return;
        }

        broadcastVoicePacket(voicePacket, matchedConnection.sessionId);
    });

    serverUdp.bind(serverConfig.port);
}

startServer(1).catch(e => {
    log.error(e);
    process.exit(1);
});
