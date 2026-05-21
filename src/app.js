import dgram from 'dgram';
import net from 'net';
import tls from 'tls';
import os from 'os';
import * as util from './lib/util.js';
import MumbleConnection from './lib/MumbleConnection.js';
import User from './lib/User.js';
import CryptState from './lib/CryptState.js';
import {
    getChannels,
    loadChannelLinks,
    buildChannelStatePayload,
    buildChannelNameValidator
} from './lib/channelHelpers.js';
import { buildUsernameValidator } from './lib/userHelpers.js';
import { getVoiceTarget } from './lib/voice.js';
import { collectVoiceTargetRecipients } from './lib/voiceRouting.js';
import { buildContextActionModifyPayload } from './lib/miscPayloads.js';
import { loadAclState } from './lib/Acl.js';
import { isActiveConnectionState } from './lib/stateHelpers.js';
import { createChannelOperations } from './lib/channelOperations.js';
import { createCodecNegotiation } from './lib/codecNegotiation.js';
import Config from './models/config.js';
import { sequelize } from './models/index.js';
import { ensureDatabaseReady, resolveConfigFileValue } from './lib/bootstrapDatabase.js';
import { DEFAULT_SERVER_CONFIG, coerceServerConfigValue } from './lib/serverConfig.js';
import { createLogger } from './lib/logger.js';
import { DATA_DIR } from './lib/paths.js';
import pkg from '../package.json' with { type: 'json' };
import { setupConnection } from './handlers/connection.js';
import { setupUser } from './handlers/user.js';
import { setupChannel, setupTextMessage } from './handlers/channel.js';
import { setupAcl } from './handlers/acl.js';
import { setupContextAction, setupBan } from './handlers/misc.js';
import { setupVoice, setupUdpVoice } from './handlers/voice.js';

let log = createLogger();
const CELT_COMPAT_BITSTREAM = -2147483637;

async function getServerIds() {
    const [rows] = await sequelize.query('SELECT server_id FROM servers ORDER BY server_id ASC');
    return rows.map(row => Number(row.server_id)).filter(serverId => Number.isFinite(serverId) && serverId > 0);
}

async function startServer(serverId) {
    const serverConfig = { ...DEFAULT_SERVER_CONFIG };

    const dbConfigs = await Config.findAll({
        where: { server_id: serverId }
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

    const channels = await getChannels(serverId);
    await loadChannelLinks(serverId, channels);
    const aclState = await loadAclState(serverId);

    const Users = new User(log, {
        serverId,
        maxUsers: serverConfig.users || DEFAULT_SERVER_CONFIG.users,
        serverPassword: serverConfig.serverpassword,
        usernameValidator
    });
    const connectionsBySession = new Map();
    const contextActions = new Map();
    const udpAddrToConnection = new Map();
    const codecState = { alpha: 0, beta: 0, preferAlpha: true, opus: false };
    let serverUdp;

    function getUdpAddrKey(rinfo) {
        return `${rinfo.address}:${rinfo.port}`;
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

    function findUserBySession(session) {
        return Object.values(Users.users).find(user => user && user.session === session);
    }

    function refreshAclState(nextAclState) {
        aclState.channelAcls = nextAclState.channelAcls;
        aclState.channelGroups = nextAclState.channelGroups;
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

    function sendVoicePacket(connection, rawPacket, fallbackRinfo) {
        if (connection?.cryptState && connection.udpaddr) {
            try {
                const encrypted = connection.cryptState.encrypt(rawPacket);
                const { address, port } = connection.udpaddr;
                udpAddrToConnection.set(getUdpAddrKey(connection.udpaddr), connection);
                serverUdp.send(encrypted, port, address, err => {
                    if (err) log.error({ err }, 'Failed to send voice packet');
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
                if (err) log.error({ err }, 'Failed to send fallback voice packet');
            });
        }
    }

    function broadcastVoicePacket(rawPacket, sourceSession) {
        const sourceChannelId = Users.sessionToChannels[sourceSession];
        if (sourceChannelId === undefined || sourceChannelId === null) return;

        const target = getVoiceTarget(rawPacket);
        const sourceConnection = connectionsBySession.get(sourceSession);
        const sourceUser = findUserBySession(sourceSession);
        if (!sourceConnection || !sourceUser) return;

        if (target === 31) {
            if (sourceConnection) sendVoicePacket(sourceConnection, rawPacket);
            return;
        }

        if (target > 0 && target < 31) {
            const targetDefinition = sourceConnection.voiceTargets?.get(target);
            if (!targetDefinition) return;

            const { directRecipients, channelRecipients } = collectVoiceTargetRecipients(
                sourceSession,
                sourceUser,
                targetDefinition,
                channels,
                aclState,
                Users,
                connectionsBySession
            );

            for (const recipient of channelRecipients.values()) sendVoicePacket(recipient, rawPacket);
            for (const [session, recipient] of directRecipients.entries()) {
                if (!channelRecipients.has(session)) sendVoicePacket(recipient, rawPacket);
            }
            return;
        }

        for (const user of Object.values(Users.users)) {
            if (!user || user.session === undefined || user.session === null) continue;
            if (user.session === sourceSession) continue;
            if (user.channelId !== sourceChannelId) continue;
            if (user.selfDeaf === true) continue;
            const targetConnection = connectionsBySession.get(user.session);
            if (targetConnection) sendVoicePacket(targetConnection, rawPacket);
        }
    }

    function requestCryptResync(connection) {
        if (!connection?.cryptState || !connection.cryptState.shouldRequestResync()) return;
        if (connection.lastCryptResync && Date.now() / 1000 - connection.lastCryptResync < 5) return;
        connection.lastCryptResync = Math.floor(Date.now() / 1000);
        connection.sendMessage('CryptSetup', {});
    }

    const channelOps = createChannelOperations({
        serverId,
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

    const sharedCtx = {
        log,
        serverId,
        serverConfig,
        channels,
        aclState,
        Users,
        connectionsBySession,
        contextActions,
        udpAddrToConnection,
        codecState,
        serverUdp,
        channelOps,
        codecNegotiation,
        sequelize,
        getUdpAddrKey,
        getLiveUserCount,
        findUserBySession,
        refreshAclState,
        broadcastContextAction,
        sendVoicePacket,
        broadcastVoicePacket,
        requestCryptResync
    };

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

        const state = {
            uid: undefined,
            auth: false,
            ready: false,
            pendingUserStates: [],
            attemptedUsername: '',
            connectionCloseError: null
        };

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

        const connCtx = { connection, socket, state, ctx: sharedCtx };

        const { formatUserLogPrefix, formatClientVersion, logRejectedConnection } = setupConnection(connCtx);
        const userCtx = {
            ...connCtx,
            ctx: { ...sharedCtx, formatUserLogPrefix, formatClientVersion, logRejectedConnection }
        };
        setupUser(userCtx);
        setupChannel(connCtx);
        setupTextMessage(connCtx);
        setupAcl(connCtx);
        setupContextAction(connCtx);
        setupBan(connCtx);
        setupVoice(connCtx);

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

    sharedCtx.serverUdp = serverUdp;

    setupUdpVoice({
        ctx: {
            ...sharedCtx,
            getLiveUserCount,
            sendVoicePacket,
            broadcastVoicePacket,
            requestCryptResync,
            findUserBySession
        }
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
            serverId,
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
    log.withDetails('warn', { configPath: bootstrap.configPath }, 'Server config file not found; using defaults');
} else {
    log.withDetails(
        'info',
        { configPath: bootstrap.configPath },
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
        { serverId: serverIds[0], username: 'SuperUser', password: bootstrap.superUserPassword },
        `Password for 'SuperUser' set to '${bootstrap.superUserPassword}'`
    );
}

try {
    await Promise.all(serverIds.map(id => startServer(id)));
} catch (e) {
    if (e?.code === 'EADDRINUSE') {
        log.error(e.message);
    } else {
        log.error(e);
    }
    process.exit(1);
}
