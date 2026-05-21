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

export { getBans, storeBanEntry, sendBanList };
