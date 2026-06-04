import { getVoiceKind, rebuildVoicePacket } from '../lib/voice.js';
import { sendUdpPingReply } from '../lib/udpPing.js';

export function setupVoice({ connection }) {
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
}

export function setupUdpVoice({
    ctx: {
        log,
        serverConfig,
        serverUdp,
        connectionsBySession,
        udpAddrToConnection,
        getUdpAddrKey,
        getLiveUserCount,
        sendVoicePacket,
        broadcastVoicePacket,
        requestCryptResync
    }
}) {
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

        try {
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
        } catch (err) {
            log.error({ err }, 'Failed to process voice packet');
        }
    });
}
