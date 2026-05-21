import { buildUserStatePayload } from '../lib/userHelpers.js';
import { isActiveConnectionState } from '../lib/stateHelpers.js';

export function setupConnection({
    connection,
    socket,
    state,
    ctx: {
        log,
        connectionsBySession,
        udpAddrToConnection,
        getUdpAddrKey,
        Users,
        codecNegotiation,
        channelOps,
        broadcastVoicePacket
    }
}) {
    function formatUserLogPrefix(user) {
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
        state.attemptedUsername = username || '';
        const attemptedUser = {
            session: connection.sessionId,
            name: state.attemptedUsername,
            userId: -1
        };
        log.info(
            `${formatUserLogPrefix(attemptedUser)} Rejected connection from ${formatRemoteAddress()}: ${formatRejectReason(reject)}`
        );
    }

    function logPreAuthConnectionClosed() {
        const attemptedUser = {
            session: connection.sessionId,
            name: state.attemptedUsername,
            userId: -1
        };
        const reason = state.connectionCloseError?.code || state.connectionCloseError?.message;
        const suffix = reason ? `: ${reason}` : '';
        log.info(`${formatUserLogPrefix(attemptedUser)} Connection closed${suffix}`);
    }

    log.info(`${formatUserLogPrefix()} New connection: ${formatRemoteAddress()}`);

    connection.on('protocol-in', () => {
        connection.lastActivityAt = Date.now();
    });

    function broadcastListener(type, message, senderUid) {
        if (!isActiveConnectionState(connection.state)) {
            return;
        }

        if (senderUid !== undefined) {
            if (type !== 'UserState' && senderUid === state.uid) {
                return;
            }
        }

        if (type === 'TextMessage') {
            const user = Users.getUser(state.uid);
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

    function broadcastAudio(packet, sourceSession) {
        broadcastVoicePacket(packet, sourceSession);
    }

    Users.on('broadcast_audio', broadcastAudio);

    connection.on('error', err => {
        if (err?.message === 'Socket is closed') {
            return;
        }

        state.connectionCloseError = err;
        if (err?.message === 'Socket timed out') {
            return;
        }

        const userLogPrefix = formatUserLogPrefix();
        log.error({ err }, userLogPrefix ? `${userLogPrefix} Connection error` : 'Connection error');
    });

    connection.on('disconnect', async () => {
        const user = Users.getUser(state.uid);
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
                state.uid
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
            await Users.deleteUser(state.uid);
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

    return { formatUserLogPrefix, formatClientVersion, logRejectedConnection };
}
