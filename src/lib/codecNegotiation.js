import { isActiveConnectionState } from './stateHelpers.js';
import { buildCodecVersionPayload } from './miscPayloads.js';

export function createCodecNegotiation({ CELT_COMPAT_BITSTREAM, connectionsBySession, codecState, log }) {
    function getEffectiveClientCodecs(connection) {
        if (
            !connection ||
            !Array.isArray(connection.clientCeltVersions) ||
            connection.clientCeltVersions.length === 0
        ) {
            return [CELT_COMPAT_BITSTREAM];
        }

        return connection.clientCeltVersions
            .filter(codec => Number.isInteger(Number(codec)))
            .map(codec => Number(codec));
    }

    function updateCodecVersions(connectingConnection = null) {
        const codecUsers = new Map();
        let users = 0;
        let opusUsers = 0;
        const opusWarningText =
            "<strong>WARNING:</strong> Your client doesn't support the Opus codec the server is switching to, you won't be able to talk or hear anyone. Please upgrade to a client with Opus support.";

        for (const connection of connectionsBySession.values()) {
            if (!connection || connection.state !== 'ready') {
                continue;
            }

            users += 1;
            if (connection.clientOpus) {
                opusUsers += 1;
            }

            for (const codec of getEffectiveClientCodecs(connection)) {
                codecUsers.set(codec, (codecUsers.get(codec) || 0) + 1);
            }
        }

        if (connectingConnection) {
            users += 1;
            if (connectingConnection.clientOpus) {
                opusUsers += 1;
            }

            for (const codec of getEffectiveClientCodecs(connectingConnection)) {
                codecUsers.set(codec, (codecUsers.get(codec) || 0) + 1);
            }
        }

        let winner = CELT_COMPAT_BITSTREAM;
        let count = 0;
        for (const [codec, codecCount] of codecUsers.entries()) {
            if (codecCount > count || (codecCount === count && codec > winner)) {
                count = codecCount;
                winner = codec;
            }
        }

        const enableOpus = users > 0 && users === opusUsers;
        const current = codecState.preferAlpha ? codecState.alpha : codecState.beta;

        if (winner !== current) {
            if (winner === CELT_COMPAT_BITSTREAM) {
                codecState.preferAlpha = true;
            } else {
                codecState.preferAlpha = !codecState.preferAlpha;
            }

            if (codecState.preferAlpha) {
                codecState.alpha = winner;
            } else {
                codecState.beta = winner;
            }
        } else if (codecState.opus === enableOpus) {
            if (codecState.opus && connectingConnection && !connectingConnection.clientOpus) {
                connectingConnection.sendMessage('TextMessage', {
                    session: [connectingConnection.sessionId],
                    message: opusWarningText
                });
            }
            return false;
        }

        const changed = codecState.opus !== enableOpus || winner !== current;
        codecState.opus = enableOpus;

        if (changed) {
            const formatHex = val => (val === 0 ? '0' : (BigInt(val) & 0xffffffffffffffffn).toString(16));
            const alphaHex = formatHex(codecState.alpha);
            const betaHex = formatHex(codecState.beta);
            const preferHex = codecState.preferAlpha ? alphaHex : betaHex;
            log.info(
                `CELT codec switch ${alphaHex} ${betaHex} (prefer ${preferHex}) (Opus ${codecState.opus ? 1 : 0})`
            );

            for (const connection of connectionsBySession.values()) {
                if (!connection || !isActiveConnectionState(connection.state)) {
                    continue;
                }

                connection.sendMessage('CodecVersion', buildCodecVersionPayload(codecState));
            }

            if (codecState.opus) {
                for (const connection of connectionsBySession.values()) {
                    if (!connection || !isActiveConnectionState(connection.state)) {
                        continue;
                    }

                    if (!connection.clientOpus) {
                        connection.sendMessage('TextMessage', {
                            session: [connection.sessionId],
                            message: opusWarningText
                        });
                    }
                }

                if (connectingConnection && !connectingConnection.clientOpus) {
                    connectingConnection.sendMessage('TextMessage', {
                        session: [connectingConnection.sessionId],
                        message: opusWarningText
                    });
                }
            }
        }

        return changed;
    }

    return {
        getEffectiveClientCodecs,
        updateCodecVersions
    };
}
