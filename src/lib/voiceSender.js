import { getVoiceTarget } from './voice.js';
import { collectVoiceTargetRecipients } from './voiceRouting.js';

export function createVoiceSender({
    channels,
    aclState,
    Users,
    connectionsBySession,
    udpAddrToConnection,
    getUdpAddrKey,
    findUserBySession,
    log
}) {
    let serverUdp;

    function setServerUdp(udp) {
        serverUdp = udp;
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

    return {
        setServerUdp,
        sendVoicePacket,
        broadcastVoicePacket
    };
}
