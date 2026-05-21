import net from 'net';
import { ipv6StringToBuffer } from './ipUtil.js';
import { sequelize } from '../models/index.js';

async function getBans(serverId) {
    const [rows] = await sequelize.query(
        `SELECT base, mask, name, hash, reason, start, duration
         FROM bans
         WHERE server_id = ${Number(serverId)}
         ORDER BY start DESC`
    );

    return rows;
}

function ipToBanBuffer(address) {
    if (typeof address !== 'string' || address.length === 0) {
        return Buffer.alloc(0);
    }

    const family = net.isIP(address);
    if (family === 4) {
        const octets = address.split('.').map(part => Number(part));
        if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) {
            return Buffer.alloc(0);
        }

        const buffer = Buffer.alloc(16);
        buffer[10] = 0xff;
        buffer[11] = 0xff;
        buffer[12] = octets[0];
        buffer[13] = octets[1];
        buffer[14] = octets[2];
        buffer[15] = octets[3];
        return buffer;
    }

    if (family === 6) {
        return ipv6StringToBuffer(address);
    }

    return Buffer.alloc(0);
}

async function storeBanEntry(serverId, entry) {
    await sequelize.query(
        `INSERT INTO bans (server_id, base, mask, name, hash, reason, start, duration)
         VALUES (
            ${Number(serverId)},
            ${sequelize.escape(entry.address || Buffer.alloc(0))},
            ${sequelize.escape(Number(entry.mask || 0))},
            ${sequelize.escape(entry.name || null)},
            ${sequelize.escape(entry.hash || null)},
            ${sequelize.escape(entry.reason || null)},
            ${sequelize.escape(entry.start || new Date().toISOString())},
            ${sequelize.escape(Number(entry.duration || 0))}
         )`
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

export { getBans, ipToBanBuffer, storeBanEntry, sendBanList };
