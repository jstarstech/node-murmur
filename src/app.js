import dgram from 'dgram';
import crypto from 'crypto';
import net from 'net';
import tls from 'tls';
import os from 'os';
import * as util from './lib/util.js';
import MumbleConnection from './lib/MumbleConnection.js';
import User from './lib/User.js';
import {
    buildAclResponse,
    canEnterChannel,
    collectAclUserIds,
    computePermissions,
    loadAclState,
    PERMISSIONS,
    saveAclState
} from './lib/Acl.js';
import CryptState from './lib/CryptState.js';
import { getVoiceKind, getVoiceTarget, rebuildVoicePacket } from './lib/voice.js';
import { sendUdpPingReply } from './lib/udpPing.js';
import {
    getChannels,
    loadChannelLinks,
    buildChannelStatePayload,
    sendChannelTree,
    buildChannelNameValidator
} from './lib/channelHelpers.js';
import {
    buildUserStatePayload,
    buildUserStatsPayload,
    createRegisteredUser,
    setUserInfoValue,
    sendRegisteredUsers,
    sendQueryUsers,
    buildUsernameValidator
} from './lib/userHelpers.js';
import { getBans, storeBanEntry, sendBanList } from './lib/banHelpers.js';
import { ipToBuffer } from './lib/ipUtil.js';
import { collectVoiceTargetRecipients } from './lib/voiceRouting.js';
import { buildContextActionModifyPayload, buildCodecVersionPayload } from './lib/miscPayloads.js';
import { isActiveConnectionState, isVersionNegotiatedState } from './lib/stateHelpers.js';
import { createChannelOperations } from './lib/channelOperations.js';
import { createCodecNegotiation } from './lib/codecNegotiation.js';
import Config from './models/config.js';
import RegisteredUsers from './models/users.js';
import UserInfo from './models/user_info.js';
import { sequelize } from './models/index.js';
import { ensureDatabaseReady, resolveConfigFileValue } from './lib/bootstrapDatabase.js';
import { DEFAULT_SERVER_CONFIG, coerceServerConfigValue } from './lib/serverConfig.js';
import { createLogger } from './lib/logger.js';
import { DATA_DIR } from './lib/paths.js';
import pkg from '../package.json' with { type: 'json' };

let log = createLogger();
const CELT_COMPAT_BITSTREAM = -2147483637;

async function getServerIds() {
    const [rows] = await sequelize.query('SELECT server_id FROM servers ORDER BY server_id ASC');
    return rows.map(row => Number(row.server_id)).filter(serverId => Number.isFinite(serverId) && serverId > 0);
}

async function startServer(server_id) {
    const serverConfig = { ...DEFAULT_SERVER_CONFIG };

    const dbConfigs = await Config.findAll({
        where: {
            server_id
        }
    }).catch(err => {
        log.error({ err }, 'Failed to load server config');

        return [];
    });

    for (const dbConfig of dbConfigs) {
        const value = coerceServerConfigValue(dbConfig.key, dbConfig.value);
        if (dbConfig.key === 'sslKey' || dbConfig.key === 'sslCert') {
            serverConfig[dbConfig.key] = resolveConfigFileValue(value);
            continue;
        }

        serverConfig[dbConfig.key] = value;
    }

    const channelNameValidator = buildChannelNameValidator(serverConfig.channelname);
    const usernameValidator = buildUsernameValidator(serverConfig.username);
    const listenHost =
        serverConfig.host || serverConfig.bindhost || serverConfig.bindip || serverConfig.ip || undefined;

    const channels = await getChannels(server_id);
    await loadChannelLinks(server_id, channels);
    const aclState = await loadAclState(server_id);

    const Users = new User(log, {
        serverId: server_id,
        maxUsers: serverConfig.users || DEFAULT_SERVER_CONFIG.users,
        serverPassword: serverConfig.serverpassword,
        usernameValidator
    });
    const connectionsBySession = new Map();

    function disconnectLiveSessionsByRegisteredUserId(userId) {
        const targetUserId = Number(userId);

        for (const user of Object.values(Users.users)) {
            if (!user || Number(user.userId) !== targetUserId) {
                continue;
            }

            const connection = connectionsBySession.get(user.session);
            if (!connection) {
                continue;
            }

            connection.removalInfo = {
                actor: null,
                reason: 'Removed by administrator',
                ban: false
            };
            connection.disconnect();
        }
    }

    function getLiveUserCount() {
        let count = 0;
        for (const connection of connectionsBySession.values()) {
            if (connection && isActiveConnectionState(connection.state)) {
                count += 1;
            }
        }
        return count;
    }
    const contextActions = new Map();
    const udpAddrToConnection = new Map();
    const codecState = {
        alpha: 0,
        beta: 0,
        preferAlpha: true,
        opus: false
    };
    let serverUdp;

    const channelOps = createChannelOperations({
        serverId: server_id,
        channels,
        aclState,
        serverConfig,
        channelNameValidator,
        sequelize,
        Users,
        refreshAclState: next => {
            aclState.channelAcls = next.channelAcls;
            aclState.channelGroups = next.channelGroups;
        },
        broadcastChannelState: channel => {
            Users.emit('broadcast', 'ChannelState', buildChannelStatePayload(channel, channels));
        }
    });

    const codecNegotiation = createCodecNegotiation({
        CELT_COMPAT_BITSTREAM,
        connectionsBySession,
        codecState,
        log
    });

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
                        log.error({ err }, 'Failed to send voice packet');
                    }
                });
                return;
            } catch (err) {
                log.error({ err }, 'Failed to encrypt voice packet');
            }
        }

        if (connection && typeof connection.sendMessage === 'function') {
            connection.sendMessage('UDPTunnel', rawPacket);
            return;
        }

        if (fallbackRinfo && serverUdp) {
            serverUdp.send(rawPacket, fallbackRinfo.port, fallbackRinfo.address, err => {
                if (err) {
                    log.error({ err }, 'Failed to send fallback voice packet');
                }
            });
        }
    }

    function findUserBySession(session) {
        return Object.values(Users.users).find(user => user && user.session === session);
    }

    function refreshAclState(nextAclState) {
        aclState.aclRowsByChannel = nextAclState.aclRowsByChannel;
        aclState.groupsByChannel = nextAclState.groupsByChannel;
    }

    function broadcastContextAction(action, entry, operation) {
        const payload = buildContextActionModifyPayload(action, entry, operation);

        for (const connection of connectionsBySession.values()) {
            if (!connection || !isActiveConnectionState(connection.state)) {
                continue;
            }

            connection.sendMessage('ContextActionModify', payload);
        }
    }

    function broadcastVoicePacket(rawPacket, sourceSession) {
        const sourceChannelId = Users.sessionToChannels[sourceSession];
        if (sourceChannelId === undefined || sourceChannelId === null) {
            return;
        }

        const target = getVoiceTarget(rawPacket);
        const sourceConnection = connectionsBySession.get(sourceSession);
        const sourceUser = findUserBySession(sourceSession);

        if (!sourceConnection || !sourceUser) {
            return;
        }

        if (target === 31) {
            if (sourceConnection) {
                sendVoicePacket(sourceConnection, rawPacket);
            }
            return;
        }

        if (target > 0 && target < 31) {
            const targetDefinition = sourceConnection.voiceTargets?.get(target);
            if (!targetDefinition) {
                return;
            }

            const { directRecipients, channelRecipients } = collectVoiceTargetRecipients(
                sourceSession,
                sourceUser,
                targetDefinition,
                channels,
                aclState,
                Users,
                connectionsBySession
            );

            for (const recipient of channelRecipients.values()) {
                sendVoicePacket(recipient, rawPacket);
            }

            for (const [session, recipient] of directRecipients.entries()) {
                if (channelRecipients.has(session)) {
                    continue;
                }

                sendVoicePacket(recipient, rawPacket);
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
        key: serverConfig.sslKey,
        cert: serverConfig.sslCert,
        requestCert: true,
        rejectUnauthorized: false
    };

    const server = tls.createServer(options, socket => {
        socket.setKeepAlive(true, 10000);
        socket.setTimeout(10000);
        socket.setNoDelay(true);

        let uid;
        let auth = false;
        let ready = false;
        const pendingUserStates = [];
        let attemptedUsername = '';
        let connectionCloseError = null;

        let sessionId;
        try {
            sessionId = Users.sessionPool.get();
        } catch (err) {
            log.error(
                { err },
                `Session ID pool (${serverConfig.users || DEFAULT_SERVER_CONFIG.users}) empty, rejecting connection`
            );
            socket.destroy();
            return;
        }

        const connection = new MumbleConnection(socket, Users);
        connection.connectedAt = Date.now();
        connection.lastActivityAt = connection.connectedAt;
        connection.sessionId = sessionId;
        connection.voiceTargets = new Map();
        connection.clientCryptoModes = [];
        connection.clientCeltVersions = [];
        connection.clientOpus = false;
        connection.clientRelease = null;
        connection.clientOS = null;
        connection.clientOSVersion = null;
        connection.lastCryptResync = 0;
        connection.state = 'connected';

        function formatUserLogPrefix(user = Users.getUser(uid)) {
            const session = connection.sessionId ?? user?.session;
            if (session === undefined || session === null) {
                return null;
            }

            const name = user?.name || '';
            const userId = user?.userId ?? -1;
            return `<${session}:${name}(${userId})>`;
        }

        function formatRemoteAddress() {
            return `${socket.remoteAddress || 'unknown'}:${socket.remotePort || 0}`;
        }

        function formatClientVersion(version) {
            const numericVersion = Number(version || 0);
            const major = (numericVersion >>> 16) & 0xffff;
            const minor = (numericVersion >>> 8) & 0xff;
            const patch = numericVersion & 0xff;
            return `${major}.${minor}.${patch}`;
        }

        function formatRejectReason(reject) {
            if (reject?.type === 3 || reject?.type === 8) {
                return 'Wrong certificate or password for existing user';
            }

            return reject?.reason || 'Rejected';
        }

        function logRejectedConnection(username, reject) {
            attemptedUsername = username || '';
            const attemptedUser = {
                session: connection.sessionId,
                name: attemptedUsername,
                userId: -1
            };
            log.info(
                `${formatUserLogPrefix(attemptedUser)} Rejected connection from ${formatRemoteAddress()}: ${formatRejectReason(reject)}`
            );
        }

        function logPreAuthConnectionClosed() {
            const attemptedUser = {
                session: connection.sessionId,
                name: attemptedUsername,
                userId: -1
            };
            const reason = connectionCloseError?.code || connectionCloseError?.message;
            const suffix = reason ? `: ${reason}` : '';
            log.info(`${formatUserLogPrefix(attemptedUser)} Connection closed${suffix}`);
        }

        log.info(`${formatUserLogPrefix()} New connection: ${formatRemoteAddress()}`);

        connection.on('protocol-in', () => {
            connection.lastActivityAt = Date.now();
        });

        function broadcastListener(type, message, sender_uid) {
            if (!isActiveConnectionState(connection.state)) {
                return;
            }

            if (sender_uid !== undefined) {
                if (type !== 'UserState' && sender_uid === uid) {
                    return;
                }
            }

            if (type === 'TextMessage') {
                const user = Users.getUser(uid);
                const userSession = user.session;
                const userChannelId = user.channelId;

                const isTargetSession = Array.isArray(message.session) && message.session.includes(userSession);
                const isTargetChannel = Array.isArray(message.channelId) && message.channelId.includes(userChannelId);
                const isTargetTree =
                    Array.isArray(message.treeId) &&
                    message.treeId.some(rootId => channelOps.isChannelDescendantOf(userChannelId, rootId));

                if (!isTargetSession && !isTargetChannel && !isTargetTree) {
                    return;
                }
            }

            if (type === 'UserState') {
                connection.sendMessage(
                    type,
                    buildUserStatePayload(message, connection.clientVersion, { includeBlobs: false })
                );
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
            if (err?.message === 'Socket is closed') {
                return;
            }

            connectionCloseError = err;
            if (err?.message === 'Socket timed out') {
                return;
            }

            const userLogPrefix = formatUserLogPrefix();
            log.error({ err }, userLogPrefix ? `${userLogPrefix} Connection error` : 'Connection error');
        });

        connection.on('disconnect', async () => {
            const user = Users.getUser(uid);
            if (user.session) {
                log.info(`${formatUserLogPrefix(user)} User disconnected`);

                const sessionId = user.session;
                const removalInfo = connection.removalInfo || {};
                Users.emit(
                    'broadcast',
                    'UserRemove',
                    {
                        session: user.session,
                        actor: removalInfo.actor,
                        reason: removalInfo.reason,
                        ban: removalInfo.ban
                    },
                    uid
                );
                if (connectionsBySession.get(sessionId) === connection) {
                    connectionsBySession.delete(sessionId);
                }
                if (connection.udpaddr) {
                    const addrKey = getUdpAddrKey(connection.udpaddr);
                    if (udpAddrToConnection.get(addrKey) === connection) {
                        udpAddrToConnection.delete(addrKey);
                    }
                }
                await Users.deleteUser(uid);
                Users.releaseSession(sessionId);
            }

            if (
                !user.session &&
                connection.sessionId !== undefined &&
                connection.sessionId !== null &&
                connectionsBySession.get(connection.sessionId) !== connection
            ) {
                logPreAuthConnectionClosed();
                Users.releaseSession(connection.sessionId);
                connection.sessionId = null;
            }

            if (
                connection.sessionId !== undefined &&
                connection.sessionId !== null &&
                connectionsBySession.get(connection.sessionId) === connection
            ) {
                connectionsBySession.delete(connection.sessionId);
                Users.releaseSession(connection.sessionId);
                connection.sessionId = null;
            }

            if (connection.voiceTargets) {
                connection.voiceTargets.clear();
            }

            codecNegotiation.updateCodecVersions();

            Users.removeListener('broadcast', broadcastListener);
            Users.removeListener('broadcast_audio', broadcastAudio);
        });

        connection.on('version', version => {
            connection.state = 'version-received';
            connection.clientCryptoModes = Array.isArray(version.cryptoModes) ? version.cryptoModes : [];
            connection.clientVersion = version.version || 0;
            connection.clientRelease = version.release || null;
            connection.clientOS = version.os || null;
            connection.clientOSVersion = version.osVersion || null;

            const clientOS = connection.clientOS || 'Unknown';
            const clientRelease = connection.clientRelease || 'unknown';
            log.info(
                `${formatUserLogPrefix()} Client version ${formatClientVersion(connection.clientVersion)} (${clientOS}: ${clientRelease})`
            );
        });

        connection.on('textMessage', m => {
            if (connection.state !== 'ready') {
                return;
            }

            const message = m.message;
            if (typeof message !== 'string' || message.length === 0) {
                return;
            }

            const user = Users.getUser(uid);
            const sessions = Array.isArray(m.session) ? m.session : [];
            const channelIds = Array.isArray(m.channelId) ? m.channelId : [];
            const treeIds = Array.isArray(m.treeId) ? m.treeId : [];

            let processedMessage = message;
            if (!serverConfig.allowhtml) {
                processedMessage = util.stripHtml(message);
            }

            if (serverConfig.textmessagelength > 0 && processedMessage.length > serverConfig.textmessagelength) {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    reason: 'Message too long'
                });
                return;
            }

            if (processedMessage.length === 0) {
                return;
            }

            if (sessions.length === 0 && channelIds.length === 0 && treeIds.length === 0) {
                return;
            }

            // Permission checks
            for (const channelId of channelIds) {
                const perms = computePermissions(channelId, user, channels, aclState);
                if ((perms & PERMISSIONS.TextMessage) !== PERMISSIONS.TextMessage) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: PERMISSIONS.TextMessage,
                        channelId,
                        session: user.session,
                        reason: 'Permission denied'
                    });
                    return;
                }
            }

            for (const treeId of treeIds) {
                const perms = computePermissions(treeId, user, channels, aclState);
                if ((perms & PERMISSIONS.TextMessage) !== PERMISSIONS.TextMessage) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: PERMISSIONS.TextMessage,
                        channelId: treeId,
                        session: user.session,
                        reason: 'Permission denied'
                    });
                    return;
                }
            }

            if (sessions.length > 0) {
                // Direct messages often require TextMessage on Root or similar.
                // For simplicity, we check TextMessage on the user's current channel.
                const perms = computePermissions(user.channelId, user, channels, aclState);
                if ((perms & PERMISSIONS.TextMessage) !== PERMISSIONS.TextMessage) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: PERMISSIONS.TextMessage,
                        channelId: user.channelId,
                        session: user.session,
                        reason: 'Permission denied'
                    });
                    return;
                }
            }

            const ms = {
                actor: user.session,
                session: sessions,
                channelId: channelIds,
                treeId: treeIds,
                message: processedMessage
            };

            Users.emit('broadcast', 'TextMessage', ms, uid);
        });

        connection.on('permissionQuery', m => {
            if (connection.state !== 'ready') {
                return;
            }

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
            if (connection.state !== 'ready') {
                return;
            }

            const user = Users.getUser(uid);
            const requestedChannelId = Number(m.channelId || 0);

            if (!user || user.session === undefined) {
                return;
            }

            if (!channelOps.canEditAcl(requestedChannelId, user)) {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    permission: PERMISSIONS.Write,
                    channelId: requestedChannelId,
                    session: user.session,
                    reason: 'Permission denied'
                });
                return;
            }

            if (m.query) {
                connection.sendMessage('ACL', buildAclResponse(requestedChannelId, channels, aclState));
                sendQueryUsers(connection, 1, { ids: collectAclUserIds(requestedChannelId, channels, aclState) }).catch(
                    err => {
                        log.error({ err }, 'Failed to resolve ACL query users');
                    }
                );
                return;
            }

            saveAclState(1, requestedChannelId, m)
                .then(async () => {
                    const refreshedAclState = await loadAclState(1);
                    refreshAclState(refreshedAclState);

                    if (channels[requestedChannelId]) {
                        channels[requestedChannelId].inheritacl = m.inheritAcls !== false ? 1 : 0;
                    }
                })
                .catch(err => {
                    log.error({ err }, 'Failed to save ACL state');
                    connection.sendMessage('PermissionDenied', {
                        type: 0,
                        session: user.session,
                        reason: 'Unable to save ACL'
                    });
                });
        });

        connection.on('queryUsers', async m => {
            if (!isActiveConnectionState(connection.state)) {
                return;
            }

            await sendQueryUsers(connection, 1, m);
        });

        connection.on('userList', async m => {
            if (!isActiveConnectionState(connection.state)) {
                return;
            }

            if (!Array.isArray(m.users) || m.users.length === 0) {
                await sendRegisteredUsers(connection, server_id, m);
                return;
            }

            for (const entry of m.users) {
                const userId = Number(entry.userId || 0);
                if (userId === 0) {
                    continue;
                }

                if (entry.name === undefined || entry.name === null || String(entry.name).trim().length === 0) {
                    disconnectLiveSessionsByRegisteredUserId(userId);

                    await RegisteredUsers.destroy({
                        where: {
                            server_id,
                            user_id: userId
                        }
                    });

                    await UserInfo.destroy({
                        where: {
                            server_id,
                            user_id: userId,
                            key: 3
                        }
                    });
                    continue;
                }

                await RegisteredUsers.update(
                    {
                        name: entry.name
                    },
                    {
                        where: {
                            server_id,
                            user_id: userId
                        }
                    }
                );
            }

            await sendRegisteredUsers(connection, server_id, {});
        });

        connection.on('banList', async m => {
            if (!isActiveConnectionState(connection.state)) {
                return;
            }

            const user = Users.getUser(uid);
            const rootPermissions = computePermissions(0, user, channels, aclState);
            if ((rootPermissions & PERMISSIONS.Ban) !== PERMISSIONS.Ban) {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    permission: PERMISSIONS.Ban,
                    channelId: 0,
                    session: user.session,
                    reason: 'Permission denied'
                });
                return;
            }

            if (m.query) {
                const bans = await getBans(server_id);
                sendBanList(connection, bans);
                return;
            }

            await sequelize.query(`DELETE FROM bans WHERE server_id = ${Number(server_id)}`);

            if (Array.isArray(m.bans) && m.bans.length > 0) {
                for (const entry of m.bans) {
                    await sequelize.query(
                        `INSERT INTO bans (server_id, base, mask, name, hash, reason, start, duration)
                         VALUES (
                            ${Number(server_id)},
                            ${sequelize.escape(entry.address || Buffer.alloc(0))},
                            ${sequelize.escape(Number(entry.mask || 0))},
                            ${sequelize.escape(entry.name || null)},
                            ${sequelize.escape(entry.hash || null)},
                            ${sequelize.escape(entry.reason || null)},
                            ${sequelize.escape(entry.start ? new Date(entry.start) : null)},
                            ${sequelize.escape(Number(entry.duration || 0))}
                         )`
                    );
                }
            }
        });

        connection.on('contextActionModify', m => {
            if (!isActiveConnectionState(connection.state)) {
                return;
            }

            const action = typeof m.action === 'string' ? m.action.trim() : '';
            if (!action) {
                return;
            }

            const operation = Number(m.operation ?? 0);
            if (operation === 1) {
                if (contextActions.delete(action)) {
                    broadcastContextAction(action, null, 1);
                }
                return;
            }

            const text = typeof m.text === 'string' ? m.text.trim() : '';
            const context = Number(m.context ?? 0);
            if (!text || !Number.isFinite(context) || context <= 0) {
                return;
            }

            const entry = {
                text,
                context
            };

            contextActions.set(action, entry);
            broadcastContextAction(action, entry, 0);
        });

        connection.on('contextAction', m => {
            if (!isActiveConnectionState(connection.state)) {
                return;
            }

            const action = typeof m.action === 'string' ? m.action.trim() : '';
            if (!action) {
                return;
            }

            if (!contextActions.has(action)) {
                return;
            }

            const actor = Users.getUser(uid);
            if (!actor || actor.session === undefined) {
                return;
            }

            const payload = {
                action,
                actor: actor.session,
                session: Number(m.session || 0) || null,
                channelId: Number(m.channelId || 0) || null
            };

            log.withDetails('info', payload, 'Context action triggered');
            Users.emit('context_action', payload, uid);
        });

        connection.on('voiceTarget', m => {
            const targetId = Number(m.id || 0);
            if (!Number.isFinite(targetId) || targetId < 1 || targetId >= 31) {
                return;
            }

            if (!Array.isArray(m.targets) || m.targets.length === 0) {
                connection.voiceTargets.delete(targetId);
                return;
            }

            const targetDefinition = {
                sessions: new Set(),
                channels: []
            };

            for (const target of m.targets) {
                if (Array.isArray(target.session)) {
                    for (const session of target.session) {
                        const sessionId = Number(session);
                        if (Number.isFinite(sessionId) && sessionId > 0) {
                            targetDefinition.sessions.add(sessionId);
                        }
                    }
                }

                if (target.channelId === undefined || target.channelId === null) {
                    continue;
                }

                targetDefinition.channels.push({
                    id: Number(target.channelId),
                    subChannels: Boolean(target.children),
                    links: Boolean(target.links),
                    onlyGroup: typeof target.group === 'string' && target.group.length > 0 ? target.group : ''
                });
            }

            if (targetDefinition.sessions.size === 0 && targetDefinition.channels.length === 0) {
                connection.voiceTargets.delete(targetId);
                return;
            }

            connection.voiceTargets.set(targetId, targetDefinition);
        });

        connection.on('userRemove', async m => {
            if (!isActiveConnectionState(connection.state)) {
                return;
            }

            const actor = Users.getUser(uid);
            if (!actor || actor.session === undefined) {
                return;
            }

            const targetSession = Number(m.session || 0);
            if (!Number.isFinite(targetSession) || targetSession === 0) {
                return;
            }

            const targetConnection = connectionsBySession.get(targetSession);
            const targetUser = findUserBySession(targetSession);
            if (!targetConnection || !targetUser || targetUser.session === undefined) {
                return;
            }

            const rootPermissions = computePermissions(0, actor, channels, aclState);
            const perm = m.ban ? PERMISSIONS.Ban : PERMISSIONS.Kick;

            if (targetUser.userId === 0 || (rootPermissions & perm) !== perm) {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    permission: perm,
                    channelId: 0,
                    session: actor.session,
                    reason: 'Permission denied'
                });
                return;
            }

            if (m.ban) {
                const remoteAddress = targetConnection.socket?.socket?.remoteAddress || '';
                const banRow = {
                    address: ipToBuffer(remoteAddress),
                    mask: 128,
                    name: targetUser.name || undefined,
                    hash: targetUser.hash || undefined,
                    reason: m.reason || undefined,
                    start: new Date().toISOString(),
                    duration: 0
                };

                try {
                    await storeBanEntry(1, banRow);
                } catch (err) {
                    log.error({ err }, 'Failed to store ban entry');
                    connection.sendMessage('PermissionDenied', {
                        type: 0,
                        session: actor.session,
                        reason: 'Unable to save ban'
                    });
                    return;
                }
            }

            targetConnection.removalInfo = {
                actor: actor.session,
                reason: m.reason || undefined,
                ban: Boolean(m.ban)
            };
            targetConnection.disconnect();
        });

        connection.on('requestBlob', async m => {
            if (!isActiveConnectionState(connection.state)) {
                return;
            }

            const requestedTextures = Array.isArray(m.sessionTexture) ? m.sessionTexture : [];
            for (const session of requestedTextures) {
                const target = findUserBySession(Number(session));
                if (!target || !target.texture || target.texture.length === 0) {
                    continue;
                }

                connection.sendMessage('UserState', {
                    session: target.session,
                    texture: target.texture
                });
            }

            const requestedComments = Array.isArray(m.sessionComment) ? m.sessionComment : [];
            for (const session of requestedComments) {
                const target = findUserBySession(Number(session));
                if (!target || target.comment === null || target.comment === undefined) {
                    continue;
                }

                connection.sendMessage('UserState', {
                    session: target.session,
                    comment: target.comment.length === 0 ? '' : target.comment
                });
            }

            const requestedDescriptions = Array.isArray(m.channelDescription) ? m.channelDescription : [];
            for (const channelId of requestedDescriptions) {
                const channel = channels[Number(channelId)];
                if (!channel || !channel.description) {
                    continue;
                }

                connection.sendMessage('ChannelState', {
                    ...buildChannelStatePayload(channel, connection.clientVersion, { includeDescription: true })
                });
            }
        });

        connection.on('userStats', async m => {
            if (!isActiveConnectionState(connection.state)) {
                return;
            }

            const requester = Users.getUser(uid);
            if (!requester || requester.session === undefined) {
                return;
            }

            const targetSession = Number(m.session || 0);
            if (!Number.isFinite(targetSession) || targetSession === 0) {
                return;
            }

            const targetConnection = connectionsBySession.get(targetSession);
            const targetUser = findUserBySession(targetSession);
            if (!targetConnection || !targetUser || targetUser.session === undefined) {
                return;
            }

            const rootPermissions = computePermissions(0, requester, channels, aclState);
            const extended =
                requester.session === targetUser.session ||
                (rootPermissions & PERMISSIONS.Register) === PERMISSIONS.Register;

            if (!extended && !canEnterChannel(targetUser.channelId, requester, channels, aclState)) {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    permission: PERMISSIONS.Enter,
                    channelId: targetUser.channelId || 0,
                    session: requester.session,
                    reason: 'Permission denied'
                });
                return;
            }

            connection.sendMessage(
                'UserStats',
                buildUserStatsPayload(targetUser, targetConnection, {
                    statsOnly: m.statsOnly === true,
                    extended,
                    local: extended || targetUser.channelId === requester.channelId
                })
            );
        });

        async function handleUserState(m) {
            const actor = Users.getUser(uid);
            if (!actor || actor.session === undefined) {
                return;
            }

            let targetUserId = uid;
            let target = actor;

            if (Object.prototype.hasOwnProperty.call(m, 'session') && m.session !== null && m.session !== undefined) {
                const requestedSession = Number(m.session);
                if (!Number.isFinite(requestedSession) || requestedSession <= 0) {
                    return;
                }

                const targetEntry = Object.entries(Users.users).find(([, candidate]) => {
                    return candidate && candidate.session === requestedSession;
                });

                if (!targetEntry) {
                    return;
                }

                targetUserId = Number(targetEntry[0]);
                target = targetEntry[1];
            }

            const updateUserState = {
                session: target.session || null,
                actor: actor.session || null
            };
            const textureProvided = Object.prototype.hasOwnProperty.call(m, 'texture');
            const commentProvided = Object.prototype.hasOwnProperty.call(m, 'comment');

            if (Object.prototype.hasOwnProperty.call(m, 'userId') && m.userId !== null && m.userId !== undefined) {
                if (target.userId !== null && target.userId !== undefined) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: PERMISSIONS.SelfRegister,
                        channelId: 0,
                        session: actor.session,
                        reason: 'Already registered'
                    });
                    return;
                }

                if (!target.hash) {
                    connection.sendMessage('PermissionDenied', {
                        type: 7,
                        session: actor.session,
                        reason: 'Missing certificate'
                    });
                    return;
                }

                const rootPermissions = computePermissions(0, actor, channels, aclState);
                const requiredPermission = target === actor ? PERMISSIONS.SelfRegister : PERMISSIONS.Register;
                if ((rootPermissions & requiredPermission) !== requiredPermission) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: requiredPermission,
                        channelId: 0,
                        session: actor.session,
                        reason: 'Permission denied'
                    });
                    return;
                }

                try {
                    const registeredUserId = await createRegisteredUser(server_id, target, target.hash);
                    const updatedUser = await Users.updateUser(targetUserId, {
                        userId: registeredUserId
                    });

                    Users.emit('broadcast', 'UserState', updatedUser, targetUserId);
                } catch (err) {
                    log.error({ err }, 'Failed to register user');
                    connection.sendMessage('PermissionDenied', {
                        type: 0,
                        session: actor.session,
                        reason: 'Unable to register user'
                    });
                }

                return;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'deaf') && m.deaf !== target.deaf) {
                updateUserState.deaf = m.deaf;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'mute') && m.mute !== target.mute) {
                updateUserState.mute = m.mute;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'recording') && m.recording !== target.recording) {
                updateUserState.recording = m.recording;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'suppress') && m.suppress !== target.suppress) {
                updateUserState.suppress = m.suppress;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'selfMute') && m.selfMute !== target.selfMute) {
                updateUserState.selfMute = m.selfMute;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'selfDeaf') && m.selfDeaf !== target.selfDeaf) {
                updateUserState.selfDeaf = m.selfDeaf;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'channelId') && m.channelId !== target.channelId) {
                updateUserState.channelId = m.channelId;
            }

            if (
                Object.prototype.hasOwnProperty.call(m, 'prioritySpeaker') &&
                m.prioritySpeaker !== target.prioritySpeaker
            ) {
                updateUserState.prioritySpeaker = m.prioritySpeaker;
            }

            if (
                Object.prototype.hasOwnProperty.call(m, 'pluginIdentity') &&
                m.pluginIdentity !== target.pluginIdentity
            ) {
                updateUserState.pluginIdentity = m.pluginIdentity;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'pluginContext') && m.pluginContext !== target.pluginContext) {
                updateUserState.pluginContext = m.pluginContext;
            }

            if (
                target !== actor &&
                (Object.prototype.hasOwnProperty.call(updateUserState, 'mute') ||
                    Object.prototype.hasOwnProperty.call(updateUserState, 'deaf') ||
                    Object.prototype.hasOwnProperty.call(updateUserState, 'suppress') ||
                    Object.prototype.hasOwnProperty.call(updateUserState, 'prioritySpeaker'))
            ) {
                const rootPermissions = computePermissions(Number(target.channelId || 0), actor, channels, aclState);
                const requiresMuteDeafen = (rootPermissions & PERMISSIONS.MuteDeafen) === PERMISSIONS.MuteDeafen;

                if (target.userId === 0 || !requiresMuteDeafen) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: PERMISSIONS.MuteDeafen,
                        channelId: Number(target.channelId || 0),
                        session: actor.session,
                        reason: 'Permission denied'
                    });
                    return;
                }

                if (Object.prototype.hasOwnProperty.call(updateUserState, 'suppress')) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: PERMISSIONS.MuteDeafen,
                        channelId: Number(target.channelId || 0),
                        session: actor.session,
                        reason: 'Permission denied'
                    });
                    return;
                }
            }

            if (
                auth === true &&
                Object.prototype.hasOwnProperty.call(updateUserState, 'channelId') &&
                updateUserState.channelId !== target.channelId
            ) {
                const requestedChannelId = Number(updateUserState.channelId);
                const destinationChannel = channels[requestedChannelId];

                if (!destinationChannel) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: PERMISSIONS.Enter,
                        channelId: requestedChannelId,
                        session: actor.session,
                        reason: 'Unknown channel'
                    });
                    return;
                }

                if (target !== actor) {
                    const actorPermissions = computePermissions(
                        Number(target.channelId || 0),
                        actor,
                        channels,
                        aclState
                    );
                    if ((actorPermissions & PERMISSIONS.Move) !== PERMISSIONS.Move) {
                        connection.sendMessage('PermissionDenied', {
                            type: 1,
                            permission: PERMISSIONS.Move,
                            channelId: Number(target.channelId || 0),
                            session: actor.session,
                            reason: 'Permission denied'
                        });
                        return;
                    }
                }

                const destinationPermissions = computePermissions(requestedChannelId, actor, channels, aclState);
                const actorCanMoveHere = (destinationPermissions & PERMISSIONS.Move) === PERMISSIONS.Move;
                const targetCanEnterDestination = canEnterChannel(requestedChannelId, target, channels, aclState);

                if (!actorCanMoveHere && !targetCanEnterDestination) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: PERMISSIONS.Enter,
                        channelId: requestedChannelId,
                        session: actor.session,
                        reason: 'Permission denied'
                    });
                    return;
                }
            }

            if (textureProvided) {
                const texture = Buffer.isBuffer(m.texture)
                    ? Buffer.from(m.texture)
                    : m.texture
                      ? Buffer.from(m.texture)
                      : Buffer.alloc(0);

                if (texture.length === 0) {
                    if (target.userId !== null && target.userId !== undefined) {
                        await RegisteredUsers.update(
                            {
                                texture: null
                            },
                            {
                                where: {
                                    server_id,
                                    user_id: target.userId
                                }
                            }
                        );
                    }

                    updateUserState.texture = Buffer.alloc(0);
                    updateUserState.textureHash = Buffer.alloc(0);
                } else {
                    if (target.userId !== null && target.userId !== undefined) {
                        await RegisteredUsers.update(
                            {
                                texture
                            },
                            {
                                where: {
                                    server_id,
                                    user_id: target.userId
                                }
                            }
                        );
                    }

                    updateUserState.texture = texture;
                    updateUserState.textureHash = crypto.createHash('sha1').update(texture).digest();
                }
            }

            if (commentProvided) {
                let comment = typeof m.comment === 'string' ? m.comment : '';

                if (!serverConfig.allowhtml) {
                    comment = util.stripHtml(comment);
                }

                if (serverConfig.textmessagelength > 0 && comment.length > serverConfig.textmessagelength) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        reason: 'Comment too long'
                    });
                    return;
                }

                if (comment.length === 0) {
                    if (target.userId !== null && target.userId !== undefined) {
                        await setUserInfoValue(1, target.userId, 2, null);
                    }

                    updateUserState.comment = '';
                    updateUserState.commentHash = Buffer.alloc(0);
                } else {
                    if (target.userId !== null && target.userId !== undefined) {
                        await setUserInfoValue(1, target.userId, 2, comment);
                    }

                    updateUserState.comment = comment;
                    updateUserState.commentHash = crypto.createHash('sha1').update(comment).digest();
                }
            }

            await Users.updateUser(targetUserId, updateUserState);
            Users.emit('broadcast', 'UserState', updateUserState, targetUserId);
        }
        connection.on('userState', m => {
            if (!ready) {
                pendingUserStates.push(m);
                return;
            }

            handleUserState(m);
        });

        if (serverConfig.sendversion !== false) {
            connection.sendMessage('Version', {
                version: util.encodeVersion(1, 2, 4),
                release: `1.2.4-0.1${os.platform()}`,
                os: os.platform(),
                osVersion: os.release(),
                cryptoModes: CryptState.supportedModes()
            });
        }
        connection.state = 'version-sent';

        connection.on('authenticate', async m => {
            if (!isVersionNegotiatedState(connection.state)) {
                return;
            }

            connection.state = 'authenticating';
            attemptedUsername = m.username || '';
            const peerCertificate = socket.getPeerCertificate();
            const certificateHash =
                peerCertificate && typeof peerCertificate.fingerprint === 'string'
                    ? peerCertificate.fingerprint.replace(/:/g, '').toLowerCase()
                    : null;

            if (serverConfig.certrequired && !certificateHash) {
                const reject = {
                    type: 7,
                    reason: 'No certificate'
                };
                logRejectedConnection(m.username, reject);
                connection.sendMessage('Reject', reject);
                connection.disconnect();
                return;
            }

            const authResult = await Users.addUser(
                {
                    name: m.username,
                    password: m.password,
                    opus: m.opus,
                    hash: certificateHash,
                    channelId: serverConfig.defaultchannel
                },
                { allocateSession: false }
            );

            connection.clientCeltVersions = Array.isArray(m.celtVersions) ? m.celtVersions.slice() : [];
            connection.clientOpus = Boolean(m.opus);

            if (authResult.reject) {
                await Users.deleteUser(authResult.id);
                logRejectedConnection(m.username, authResult.reject);
                connection.sendMessage('Reject', authResult.reject);
                connection.disconnect();
                return;
            }

            if (serverConfig.users > 0 && getLiveUserCount() >= serverConfig.users && m.username !== 'SuperUser') {
                const rejectedUser = Users.getUser(authResult.id);
                const rejectedSessionId = rejectedUser.session;

                await Users.deleteUser(authResult.id);
                if (rejectedSessionId !== undefined && rejectedSessionId !== null) {
                    Users.releaseSession(rejectedSessionId);
                }

                const reject = {
                    type: 6,
                    reason: 'Server full'
                };
                logRejectedConnection(m.username, reject);
                connection.sendMessage('Reject', reject);
                connection.disconnect();
                return;
            }

            const pendingUser = Users.getUser(authResult.id);
            pendingUser.session = connection.sessionId;
            const activeUser = Users.activateUser(authResult.id);

            uid = authResult.id;
            connection.state = 'authenticated';

            auth = true;

            connection.sessionId = activeUser.session;
            connectionsBySession.set(connection.sessionId, connection);

            const negotiatedMode =
                connection.clientCryptoModes.find(mode => CryptState.supportedModes().includes(mode)) ||
                CryptState.supportedModes()[0];
            connection.cryptState = new CryptState(negotiatedMode);
            connection.cryptState.generateKey(negotiatedMode);

            log.info(`${formatUserLogPrefix(activeUser)} Authenticated`);

            connection.sendMessage('CryptSetup', connection.cryptState.getCryptSetup());

            const rootChannel = channels[0];
            sendChannelTree(connection, channels, rootChannel);

            const initialUserState = buildUserStatePayload(activeUser, connection.clientVersion, {
                includeBlobs: false,
                includeActor: false,
                includeUnsetFlags: false
            });

            Users.emit('broadcast', 'UserState', initialUserState, uid);

            for (const item of Object.values(Users.users)) {
                if (item.session === connection.sessionId) {
                    continue;
                }

                const targetConnection = connectionsBySession.get(item.session);
                if (!targetConnection || targetConnection.state !== 'ready') {
                    continue;
                }

                connection.sendMessage(
                    'UserState',
                    buildUserStatePayload(item, connection.clientVersion, {
                        includeBlobs: false,
                        includeActor: false,
                        includeUnsetFlags: false
                    })
                );
            }

            connection.sendMessage('ServerSync', {
                session: activeUser.session,
                maxBandwidth: serverConfig.bandwidth,
                welcomeText: serverConfig.welcometext,
                permissions: computePermissions(0, activeUser, channels, aclState)
            });

            connection.sendMessage('ServerConfig', {
                maxBandwidth: null,
                welcomeText: null,
                allowHtml: Boolean(serverConfig.allowhtml),
                messageLength: serverConfig.textmessagelength,
                imageMessageLength: serverConfig.imagemessagelength
            });

            const codecChanged = codecNegotiation.updateCodecVersions(connection);
            if (!codecChanged) {
                connection.sendMessage('CodecVersion', buildCodecVersionPayload(codecState));
            }

            for (const [action, entry] of contextActions.entries()) {
                connection.sendMessage('ContextActionModify', buildContextActionModifyPayload(action, entry, 0));
            }

            while (pendingUserStates.length > 0) {
                await handleUserState(pendingUserStates.shift());
            }

            ready = true;
            connection.state = 'ready';
        });

        connection.on('channelRemove', async ({ channelId }) => {
            if (connection.state !== 'ready') {
                return;
            }

            const user = Users.getUser(uid);
            if (!user || user.session === undefined) {
                return;
            }

            try {
                await channelOps.persistChannelRemoval(user, channelId);
            } catch (err) {
                log.error({ err }, 'Failed to remove channel');

                if (err.code === 'root_remove') {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: PERMISSIONS.Write,
                        channelId: 0,
                        session: user.session,
                        reason: 'Permission denied'
                    });
                    return;
                }

                if (err.code === 'permission') {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: err.permission,
                        channelId: err.channelId || Number(channelId) || 0,
                        session: user.session,
                        reason: 'Permission denied'
                    });
                    return;
                }

                connection.sendMessage('PermissionDenied', {
                    type: 0,
                    session: user.session,
                    reason: 'Unable to remove channel'
                });
            }
        });

        connection.on('channelState', async m => {
            if (connection.state !== 'ready') {
                return;
            }

            const user = Users.getUser(uid);
            if (!user || user.session === undefined) {
                return;
            }

            try {
                await channelOps.persistChannelStateChange(user, uid, m);
            } catch (err) {
                log.error({ err }, 'Failed to save channel state');

                if (err.code === 'missing_certificate') {
                    connection.sendMessage('PermissionDenied', {
                        type: 7,
                        session: user.session,
                        reason: 'Missing certificate'
                    });
                    return;
                }

                if (err.code === 'channel_name') {
                    connection.sendMessage('PermissionDenied', {
                        type: 3,
                        session: user.session,
                        reason: 'Invalid channel name'
                    });
                    return;
                }

                if (err.code === 'temporary_parent') {
                    connection.sendMessage('PermissionDenied', {
                        type: 6,
                        session: user.session,
                        reason: 'Temporary channel'
                    });
                    return;
                }

                if (err.code === 'permission') {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: err.permission,
                        channelId: err.channelId || 0,
                        session: user.session,
                        reason: 'Permission denied'
                    });
                    return;
                }

                if (err.code === 'description_too_long') {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        session: user.session,
                        reason: 'Description too long'
                    });
                    return;
                }

                connection.sendMessage('PermissionDenied', {
                    type: 0,
                    session: user.session,
                    reason: 'Unable to save channel'
                });
            }
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
                log.error({ err }, 'Failed to process crypt setup');
            }
        });
    });

    let udpDefaultHost = '0.0.0.0';
    function normalizeListenAddress(address) {
        return {
            address: typeof address === 'object' && address ? address.address : listenHost || udpDefaultHost,
            port: typeof address === 'object' && address ? address.port : serverConfig.port
        };
    }

    const tcpListening = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(serverConfig.port, listenHost, () => {
            server.off('error', reject);
            resolve(normalizeListenAddress(server.address()));
        });
    });

    const ipVersion = net.isIP(listenHost || '');
    if (ipVersion === 4) {
        serverUdp = dgram.createSocket('udp4');
    } else if (ipVersion === 6) {
        serverUdp = dgram.createSocket('udp6');
        udpDefaultHost = '::';
    } else {
        try {
            serverUdp = dgram.createSocket({ type: 'udp6', ipv6Only: false });
            udpDefaultHost = '::';
        } catch {
            serverUdp = dgram.createSocket('udp4');
            udpDefaultHost = '0.0.0.0';
        }
    }

    serverUdp.on('message', (message, rinfo) => {
        if (message.length === 12) {
            if (serverConfig.allowping === false) {
                return;
            }

            sendUdpPingReply({
                bandwidth: serverConfig.bandwidth,
                liveUserCount: getLiveUserCount(),
                log,
                message,
                rinfo,
                serverUdp
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
            matchedConnection.lastActivityAt = Date.now();
            sendVoicePacket(matchedConnection, plain, rinfo);
            return;
        }

        matchedConnection.lastActivityAt = Date.now();
        const voicePacket = rebuildVoicePacket(matchedConnection.sessionId, plain);
        if (!voicePacket) {
            return;
        }

        broadcastVoicePacket(voicePacket, matchedConnection.sessionId);
    });

    const udpListening = new Promise((resolve, reject) => {
        serverUdp.once('error', reject);
        serverUdp.bind(serverConfig.port, listenHost || udpDefaultHost, () => {
            serverUdp.off('error', reject);
            resolve(normalizeListenAddress(serverUdp.address()));
        });
    });

    const [serverListenAddress] = await Promise.all([tcpListening, udpListening]);

    log.withDetails(
        'info',
        {
            serverId: server_id,
            serverName: serverConfig.registerName || null,
            serverAddress: serverListenAddress.address,
            serverPort: serverListenAddress.port
        },
        `Server listening on ${serverListenAddress.address}:${serverListenAddress.port}`
    );
}

let bootstrap;
try {
    bootstrap = await ensureDatabaseReady();
} catch (err) {
    if (err.parent?.code === 'SQLITE_READONLY' || err.code === 'EACCES') {
        log.error('Permission denied: Unable to write to the data directory or database file.');
    } else {
        log.error({ err }, 'Failed to initialize database');
    }
    process.exit(1);
}

log = createLogger({ filePath: bootstrap.config?.logfile || DEFAULT_SERVER_CONFIG.logfile });

log.info('******************************************************');
log.info(`* ${`node-murmur v${pkg.version}`.padEnd(50)} *`);
log.info(`* ${'A Mumble-compatible voice server implementation'.padEnd(50)} *`);
log.info(`* ${'Documentation and issue tracking:'.padEnd(50)} *`);
log.info(`* ${'https://github.com/jstarstech/node-murmur'.padEnd(50)} *`);
log.info('******************************************************');

let serverIds;
try {
    serverIds = await getServerIds();
} catch (err) {
    if (err.parent?.code === 'SQLITE_READONLY' || err.code === 'EACCES') {
        log.error('Permission denied: Unable to read from the database.');
    } else {
        log.error({ err }, 'Failed to load servers from database');
    }
    process.exit(1);
}

if (bootstrap.configSource === 'defaults') {
    log.withDetails(
        'warn',
        {
            configPath: bootstrap.configPath
        },
        'Server config file not found; using defaults'
    );
} else {
    log.withDetails(
        'info',
        {
            configPath: bootstrap.configPath
        },
        `Initializing settings from: ${bootstrap.configPath}`
    );
}

log.info(`Data directory: ${DATA_DIR}`);

for (const warning of bootstrap.configWarnings || []) {
    log.warn(warning);
}

if (bootstrap.superUserPassword) {
    log.withDetails(
        'info',
        {
            serverId: serverIds[0],
            username: 'SuperUser',
            password: bootstrap.superUserPassword
        },
        `Password for 'SuperUser' set to '${bootstrap.superUserPassword}'`
    );
}

try {
    await Promise.all(serverIds.map(serverId => startServer(serverId)));
} catch (e) {
    if (e?.code === 'EADDRINUSE') {
        log.error(e.message);
    } else {
        log.error(e);
    }
    process.exit(1);
}
