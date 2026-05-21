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

export { getBans, storeBanEntry, sendBanList };
