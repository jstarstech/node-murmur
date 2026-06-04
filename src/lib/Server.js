import dgram from 'dgram';
import net from 'net';
import tls from 'tls';
import os from 'os';
import * as util from './util.js';
import MumbleConnection from './MumbleConnection.js';
import User from './User.js';
import CryptState from './CryptState.js';
import {
    getChannels,
    loadChannelLinks,
    buildChannelStatePayload,
    buildChannelNameValidator
} from './channelHelpers.js';
import { buildUsernameValidator } from './userHelpers.js';
import { buildContextActionModifyPayload } from './miscPayloads.js';
import { loadAclState } from './Acl.js';
import { isActiveConnectionState } from './stateHelpers.js';
import { createChannelOperations } from './channelOperations.js';
import { createCodecNegotiation } from './codecNegotiation.js';
import { createVoiceSender } from './voiceSender.js';
import Config from '../models/config.js';
import { resolveConfigFileValue } from './bootstrapDatabase.js';
import { DEFAULT_SERVER_CONFIG, coerceServerConfigValue } from './serverConfig.js';
import { isBanned } from './banHelpers.js';
import { ipToBuffer } from './ipUtil.js';
import { setupConnection } from '../handlers/connection.js';
import { setupUser } from '../handlers/user.js';
import { setupChannel, setupTextMessage } from '../handlers/channel.js';
import { setupAcl } from '../handlers/acl.js';
import { setupContextAction, setupBan } from '../handlers/misc.js';
import { setupVoice, setupUdpVoice } from '../handlers/voice.js';

const CELT_COMPAT_BITSTREAM = -2147483637;

export class Server {
    constructor(serverId, { log, sequelize }) {
        this.serverId = serverId;
        this._log = log;
        this._sequelize = sequelize;

        this._serverConfig = null;
        this._channels = {};
        this._aclState = null;
        this._Users = null;
        this._connectionsBySession = new Map();
        this._contextActions = new Map();
        this._udpAddrToConnection = new Map();
        this._codecState = { alpha: 0, beta: 0, preferAlpha: true, opus: false };
        this._tcpServer = null;
        this._udpSocket = null;
        this._channelOps = null;
        this._codecNegotiation = null;
        this._voiceSender = null;
        this._listenHost = null;
        this._udpDefaultHost = '0.0.0.0';
    }

    get connectionsBySession() {
        return this._connectionsBySession;
    }

    get tcpServer() {
        return this._tcpServer;
    }

    get udpSocket() {
        return this._udpSocket;
    }

    async start() {
        await this._loadConfig();
        await this._loadChannels();

        this._Users = new User(this._log, {
            serverId: this.serverId,
            maxUsers: this._serverConfig.users || DEFAULT_SERVER_CONFIG.users,
            serverPassword: this._serverConfig.serverpassword,
            usernameValidator: buildUsernameValidator(this._serverConfig.username)
        });

        this._createFactories();
        this._createTcpServer();
        this._createUdpSocket();
        this._voiceSender.setServerUdp(this._udpSocket);
        this._ctx = this._buildCtx();
        this._registerUdpHandler();
        await this._listen();

        return this;
    }

    async shutdown() {
        for (const connection of this._connectionsBySession.values()) {
            if (connection && typeof connection.disconnect === 'function') {
                connection.disconnect();
            }
        }

        this._udpSocket.close();
        this._tcpServer.close();
    }

    async _loadConfig() {
        this._serverConfig = { ...DEFAULT_SERVER_CONFIG };

        const dbConfigs = await Config.findAll({
            where: { server_id: this.serverId }
        }).catch(err => {
            this._log.error({ err }, 'Failed to load server config');
            return [];
        });

        for (const dbConfig of dbConfigs) {
            const value = coerceServerConfigValue(dbConfig.key, dbConfig.value);
            if (dbConfig.key === 'sslKey' || dbConfig.key === 'sslCert') {
                this._serverConfig[dbConfig.key] = resolveConfigFileValue(value);
                continue;
            }
            this._serverConfig[dbConfig.key] = value;
        }

        this._listenHost =
            this._serverConfig.host ||
            this._serverConfig.bindhost ||
            this._serverConfig.bindip ||
            this._serverConfig.ip ||
            undefined;
    }

    async _loadChannels() {
        this._channels = await getChannels(this.serverId);
        await loadChannelLinks(this.serverId, this._channels);
        this._aclState = await loadAclState(this.serverId);
    }

    _createFactories() {
        this._channelOps = createChannelOperations({
            serverId: this.serverId,
            channels: this._channels,
            aclState: this._aclState,
            serverConfig: this._serverConfig,
            channelNameValidator: buildChannelNameValidator(this._serverConfig.channelname),
            sequelize: this._sequelize,
            Users: this._Users,
            refreshAclState: next => {
                this._aclState.channelAcls = next.channelAcls;
                this._aclState.channelGroups = next.channelGroups;
            },
            broadcastChannelState: channel => {
                this._Users.emit('broadcast', 'ChannelState', buildChannelStatePayload(channel, this._channels));
            }
        });

        this._codecNegotiation = createCodecNegotiation({
            CELT_COMPAT_BITSTREAM,
            connectionsBySession: this._connectionsBySession,
            codecState: this._codecState,
            log: this._log
        });

        this._voiceSender = createVoiceSender({
            channels: this._channels,
            aclState: this._aclState,
            Users: this._Users,
            connectionsBySession: this._connectionsBySession,
            udpAddrToConnection: this._udpAddrToConnection,
            getUdpAddrKey: rinfo => this._getUdpAddrKey(rinfo),
            findUserBySession: session => this._findUserBySession(session),
            log: this._log
        });
    }

    _createTcpServer() {
        this._tcpServer = tls.createServer(
            {
                key: this._serverConfig.sslKey,
                cert: this._serverConfig.sslCert,
                requestCert: true,
                rejectUnauthorized: false
            },
            socket => {
                this._onConnection(socket).catch(err => {
                    this._log.error({ err }, 'Failed to handle new connection');
                    socket.destroy();
                });
            }
        );
    }

    _createUdpSocket() {
        const ipVersion = net.isIP(this._listenHost || '');

        if (ipVersion === 4) {
            this._udpSocket = dgram.createSocket('udp4');
        } else if (ipVersion === 6) {
            this._udpSocket = dgram.createSocket('udp6');
            this._udpDefaultHost = '::';
        } else {
            try {
                this._udpSocket = dgram.createSocket({ type: 'udp6', ipv6Only: false });
                this._udpDefaultHost = '::';
            } catch {
                this._udpSocket = dgram.createSocket('udp4');
            }
        }
    }

    _registerUdpHandler() {
        setupUdpVoice({ ctx: this._ctx });
    }

    async _listen() {
        const tcpListening = new Promise((resolve, reject) => {
            this._tcpServer.once('error', reject);
            this._tcpServer.listen(this._serverConfig.port, this._listenHost, () => {
                this._tcpServer.off('error', reject);
                const addr = this._tcpServer.address();
                resolve(
                    typeof addr === 'object' && addr
                        ? { address: addr.address, port: addr.port }
                        : { address: this._listenHost || '0.0.0.0', port: this._serverConfig.port }
                );
            });
        });

        const udpListening = new Promise((resolve, reject) => {
            this._udpSocket.once('error', reject);
            this._udpSocket.bind(this._serverConfig.port, this._listenHost || this._udpDefaultHost, () => {
                this._udpSocket.off('error', reject);
                resolve();
            });
        });

        const [serverListenAddress] = await Promise.all([tcpListening, udpListening]);

        this._log.withDetails(
            'info',
            {
                serverId: this.serverId,
                serverName: this._serverConfig.registerName || null,
                serverAddress: serverListenAddress.address,
                serverPort: serverListenAddress.port
            },
            `Server listening on ${serverListenAddress.address}:${serverListenAddress.port}`
        );
    }

    async _onConnection(socket) {
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
            sessionId = this._Users.sessionPool.get();
        } catch (err) {
            this._log.error(
                { err },
                `Session ID pool (${this._serverConfig.users || DEFAULT_SERVER_CONFIG.users}) empty, rejecting connection`
            );
            socket.destroy();
            return;
        }

        const connection = new MumbleConnection(socket, this._Users);
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

        const remoteAddress = socket.remoteAddress || '';
        const addressBuf = ipToBuffer(remoteAddress);
        if (addressBuf.length > 0) {
            let banned = null;
            try {
                banned = await isBanned(this.serverId, addressBuf);
            } catch (err) {
                this._log.error({ err }, 'Failed to check ban list');
            }

            if (banned) {
                this._log.info(`Rejected banned connection from ${remoteAddress}`);
                connection.sendMessage('Reject', {
                    type: 1,
                    reason: banned.reason || 'Banned'
                });
                connection.disconnect();
                // Handlers (and the disconnect handler that reclaims the session)
                // are not wired yet, so release the session id manually.
                this._Users.releaseSession(sessionId);
                return;
            }
        }

        const connCtx = { connection, socket, state, ctx: this._ctx };

        const { formatUserLogPrefix, formatClientVersion, logRejectedConnection } = setupConnection(connCtx);

        const userCtx = {
            ...connCtx,
            ctx: { ...this._ctx, formatUserLogPrefix, formatClientVersion, logRejectedConnection }
        };
        setupUser(userCtx);
        setupChannel(connCtx);
        setupTextMessage(connCtx);
        setupAcl(connCtx);
        setupContextAction(connCtx);
        setupBan(connCtx);
        setupVoice(connCtx);

        if (this._serverConfig.sendversion !== false) {
            connection.sendMessage('Version', {
                version: util.encodeVersion(1, 2, 4),
                release: `1.2.4-0.1${os.platform()}`,
                os: os.platform(),
                osVersion: os.release(),
                cryptoModes: CryptState.supportedModes()
            });
        }
        connection.state = 'version-sent';
    }

    _buildCtx() {
        return {
            log: this._log,
            serverId: this.serverId,
            serverConfig: this._serverConfig,
            channels: this._channels,
            aclState: this._aclState,
            Users: this._Users,
            connectionsBySession: this._connectionsBySession,
            contextActions: this._contextActions,
            udpAddrToConnection: this._udpAddrToConnection,
            codecState: this._codecState,
            serverUdp: this._udpSocket,
            channelOps: this._channelOps,
            codecNegotiation: this._codecNegotiation,
            sequelize: this._sequelize,
            getUdpAddrKey: rinfo => this._getUdpAddrKey(rinfo),
            getLiveUserCount: () => this._getLiveUserCount(),
            findUserBySession: session => this._findUserBySession(session),
            refreshAclState: next => this._refreshAclState(next),
            broadcastContextAction: (action, entry, operation) =>
                this._broadcastContextAction(action, entry, operation),
            sendVoicePacket: (connection, rawPacket, fallbackRinfo) =>
                this._voiceSender.sendVoicePacket(connection, rawPacket, fallbackRinfo),
            broadcastVoicePacket: (rawPacket, sourceSession) =>
                this._voiceSender.broadcastVoicePacket(rawPacket, sourceSession),
            requestCryptResync: connection => this._requestCryptResync(connection)
        };
    }

    _getUdpAddrKey(rinfo) {
        return `${rinfo.address}:${rinfo.port}`;
    }

    _getLiveUserCount() {
        let count = 0;
        for (const connection of this._connectionsBySession.values()) {
            if (connection && isActiveConnectionState(connection.state)) {
                count += 1;
            }
        }
        return count;
    }

    _findUserBySession(session) {
        return Object.values(this._Users.users).find(user => user && user.session === session);
    }

    _refreshAclState(nextAclState) {
        this._aclState.channelAcls = nextAclState.channelAcls;
        this._aclState.channelGroups = nextAclState.channelGroups;
    }

    _broadcastContextAction(action, entry, operation) {
        const payload = buildContextActionModifyPayload(action, entry, operation);
        for (const connection of this._connectionsBySession.values()) {
            if (!connection || !isActiveConnectionState(connection.state)) {
                continue;
            }
            connection.sendMessage('ContextActionModify', payload);
        }
    }

    _requestCryptResync(connection) {
        if (!connection?.cryptState || !connection.cryptState.shouldRequestResync()) return;
        if (connection.lastCryptResync && Date.now() / 1000 - connection.lastCryptResync < 5) return;
        connection.lastCryptResync = Math.floor(Date.now() / 1000);
        connection.sendMessage('CryptSetup', {});
    }
}
