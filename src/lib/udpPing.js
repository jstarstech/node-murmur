function clampInt32(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
        return 0;
    }

    return Math.max(-2147483648, Math.min(2147483647, Math.trunc(n)));
}

export function buildUdpPingReply(message, liveUserCount, bandwidth) {
    const buffer = Buffer.alloc(24);
    buffer.writeUInt32BE(0x00010204, 0);
    buffer.writeDoubleBE(message.readDoubleBE(4), 4);
    buffer.writeInt32BE(clampInt32(liveUserCount), 12);
    buffer.writeInt32BE(5, 16);
    buffer.writeInt32BE(clampInt32(bandwidth || 0), 20);
    return buffer;
}

export function sendUdpPingReply({ log, message, rinfo, serverUdp, liveUserCount, bandwidth }) {
    const buffer = buildUdpPingReply(message, liveUserCount, bandwidth);

    serverUdp.send(buffer, 0, buffer.length, rinfo.port, rinfo.address, err => {
        if (err) {
            log.trace(
                {
                    err,
                    address: rinfo.address,
                    port: rinfo.port
                },
                'Failed to send UDP ping reply'
            );
        }
    });
}
