import * as util from './util.js';

export function getVoiceKind(packet) {
    if (!packet || packet.length === 0) {
        return null;
    }

    return (packet[0] >> 5) & 0x07;
}

export function getVoiceTarget(packet) {
    if (!packet || packet.length === 0) {
        return null;
    }

    return packet[0] & 0x1f;
}

export function rebuildVoicePacket(sessionId, data) {
    if (!data || data.length === 0) {
        return null;
    }

    const header = data[0];
    const target = header & 0x1f;
    const type = (header >> 5) & 0x07;

    if (type !== 0 && type !== 2 && type !== 3 && type !== 4) {
        return null;
    }

    const sequence = util.fromVarint(data.subarray(1));
    const packet = data.subarray(1 + sequence.length);
    const sequenceVarint = util.toVarint(sequence.value);
    const sessionVarint = util.toVarint(sessionId);
    const voicePacket = Buffer.alloc(1 + sessionVarint.length + sequenceVarint.length + packet.length);

    voicePacket[0] = (type << 5) | target;
    sessionVarint.value.copy(voicePacket, 1);
    sequenceVarint.value.copy(voicePacket, 1 + sessionVarint.length);
    packet.copy(voicePacket, 1 + sessionVarint.length + sequenceVarint.length);

    return voicePacket;
}
