import { sequelize } from '../models/index.js';

async function getBans(serverId) {
    const [rows] = await sequelize.query(
        `SELECT base, mask, name, hash, reason, start, duration
         FROM bans
         WHERE server_id = ?
         ORDER BY start DESC`,
        { replacements: [Number(serverId)] }
    );

    return rows;
}

async function storeBanEntry(serverId, entry) {
    await sequelize.query(
        `INSERT INTO bans (server_id, base, mask, name, hash, reason, start, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        {
            replacements: [
                Number(serverId),
                entry.address || Buffer.alloc(0),
                Number(entry.mask || 0),
                entry.name || null,
                entry.hash || null,
                entry.reason || null,
                entry.start || new Date().toISOString(),
                Number(entry.duration || 0)
            ]
        }
    );
}

function sendBanList(connection, bans) {
    connection.sendMessage('BanList', {
        bans: bans.map(banEntry => ({
            address: banEntry.base || Buffer.alloc(0),
            mask: Number(banEntry.mask || 0),
            name: banEntry.name || undefined,
            hash: banEntry.hash || undefined,
            reason: banEntry.reason || undefined,
            start: banEntry.start ? new Date(banEntry.start).toISOString() : undefined,
            duration: Number(banEntry.duration || 0)
        }))
    });
}

function isBanExpired(banEntry) {
    if (Number(banEntry.duration || 0) === 0) {
        return false;
    }

    const start = banEntry.start ? new Date(banEntry.start).getTime() : 0;
    const durationMs = Number(banEntry.duration || 0) * 1000;
    return Date.now() > start + durationMs;
}

function isV4Mapped(buf) {
    return (
        buf.length === 16 &&
        buf[10] === 0xff &&
        buf[11] === 0xff &&
        buf[0] === 0 &&
        buf[1] === 0 &&
        buf[2] === 0 &&
        buf[3] === 0 &&
        buf[4] === 0 &&
        buf[5] === 0 &&
        buf[6] === 0 &&
        buf[7] === 0 &&
        buf[8] === 0 &&
        buf[9] === 0
    );
}

function extractV4(buf) {
    return buf.slice(12, 16);
}

function applyMask(buf, maskBits) {
    const result = Buffer.alloc(buf.length);
    let bits = maskBits;

    for (let i = 0; i < buf.length; i++) {
        if (bits >= 8) {
            result[i] = buf[i];
            bits -= 8;
        } else if (bits > 0) {
            result[i] = buf[i] & (0xff << (8 - bits));
            bits = 0;
        } else {
            result[i] = 0;
        }
    }

    return result;
}

function ipMatchesBan(address, banEntry) {
    if (!address || address.length === 0) {
        return false;
    }

    const base = banEntry.base || Buffer.alloc(0);
    const addr = address;
    const mask = Number(banEntry.mask || 0);

    let effectiveBase = base;
    let effectiveAddr = addr;
    let effectiveMask = mask;

    if (effectiveBase.length === effectiveAddr.length) {
        // Lengths match — compare directly
    } else if (effectiveBase.length === 16 && effectiveAddr.length === 4 && isV4Mapped(effectiveBase)) {
        // Ban stored as ::ffff:IPv6, address is raw IPv4
        effectiveBase = extractV4(effectiveBase);
        effectiveAddr = addr;
    } else if (effectiveBase.length === 4 && effectiveAddr.length === 16 && isV4Mapped(effectiveAddr)) {
        effectiveAddr = extractV4(effectiveAddr);
        effectiveBase = base;
    } else {
        return false;
    }

    effectiveMask = Math.min(effectiveMask, effectiveBase.length * 8);

    const maskedAddr = applyMask(effectiveAddr, effectiveMask);
    const maskedBase = applyMask(effectiveBase, effectiveMask);

    return maskedAddr.equals(maskedBase);
}

async function isBanned(serverId, address, certHash) {
    const bans = await getBans(serverId);

    for (const banEntry of bans) {
        if (isBanExpired(banEntry)) {
            continue;
        }

        if (certHash && banEntry.hash === certHash && ipMatchesBan(address, banEntry)) {
            return { reason: banEntry.reason || undefined };
        }

        if (address && ipMatchesBan(address, banEntry)) {
            return { reason: banEntry.reason || undefined };
        }
    }

    return null;
}

export { getBans, storeBanEntry, sendBanList, isBanned, isBanExpired, ipMatchesBan };
