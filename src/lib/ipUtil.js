import net from 'net';

function ipv6StringToBuffer(address) {
    const normalized = address.split('%')[0].toLowerCase();
    const [leftRaw, rightRaw] = normalized.includes('::') ? normalized.split('::') : [normalized, ''];

    if (normalized.split('::').length > 2) {
        return Buffer.alloc(0);
    }

    const parsePart = part => {
        if (!part) {
            return [];
        }

        const pieces = part.split(':').filter(Boolean);
        const values = [];

        for (const piece of pieces) {
            if (piece.includes('.')) {
                const octets = piece.split('.').map(value => Number(value));
                if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
                    return null;
                }

                values.push(((octets[0] << 8) | octets[1]) & 0xffff);
                values.push(((octets[2] << 8) | octets[3]) & 0xffff);
                continue;
            }

            const value = Number.parseInt(piece, 16);
            if (!Number.isInteger(value) || Number.isNaN(value) || value < 0 || value > 0xffff) {
                return null;
            }

            values.push(value);
        }

        return values;
    };

    const left = parsePart(leftRaw);
    const right = parsePart(rightRaw);
    if (left === null || right === null) {
        return Buffer.alloc(0);
    }

    let groups;
    if (normalized.includes('::')) {
        const zeroGroups = 8 - (left.length + right.length);
        if (zeroGroups < 0) {
            return Buffer.alloc(0);
        }

        groups = [...left, ...Array(zeroGroups).fill(0), ...right];
    } else {
        groups = left;
        if (groups.length !== 8) {
            return Buffer.alloc(0);
        }
    }

    if (groups.length !== 8) {
        return Buffer.alloc(0);
    }

    const buffer = Buffer.alloc(16);
    groups.forEach((group, index) => {
        buffer.writeUInt16BE(group & 0xffff, index * 2);
    });
    return buffer;
}

function ipToBuffer(address) {
    if (typeof address !== 'string' || address.length === 0) {
        return Buffer.alloc(0);
    }

    const normalized = address.split('%')[0];

    if (normalized.startsWith('::ffff:')) {
        const ipv4 = normalized.slice('::ffff:'.length);
        if (net.isIP(ipv4) === 4) {
            const octets = ipv4.split('.').map(part => Number(part));
            if (octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) {
                return Buffer.from(octets);
            }
        }
    }

    const family = net.isIP(normalized);
    if (family === 4) {
        const octets = normalized.split('.').map(part => Number(part));
        if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
            return Buffer.alloc(0);
        }

        return Buffer.from(octets);
    }

    if (family === 6) {
        return ipv6StringToBuffer(address);
    }

    return Buffer.alloc(0);
}

export { ipToBuffer };
