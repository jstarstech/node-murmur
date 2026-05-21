import { computePermissions, PERMISSIONS } from '../lib/Acl.js';
import { getBans, sendBanList } from '../lib/banHelpers.js';
import { isActiveConnectionState } from '../lib/stateHelpers.js';

export function setupContextAction({ connection, state, ctx: { log, contextActions, Users, broadcastContextAction } }) {
    connection.on('contextActionModify', m => {
        if (!isActiveConnectionState(connection.state)) {
            return;
        }

        const action = typeof m.action === 'string' ? m.action.trim() : '';
        if (!action) {
            return;
        }

        const operation = Number(m.operation ?? 0);
        if (operation === 1) {
            if (contextActions.delete(action)) {
                broadcastContextAction(action, null, 1);
            }
            return;
        }

        const text = typeof m.text === 'string' ? m.text.trim() : '';
        const context = Number(m.context ?? 0);
        if (!text || !Number.isFinite(context) || context <= 0) {
            return;
        }

        const entry = {
            text,
            context
        };

        contextActions.set(action, entry);
        broadcastContextAction(action, entry, 0);
    });

    connection.on('contextAction', m => {
        if (!isActiveConnectionState(connection.state)) {
            return;
        }

        const action = typeof m.action === 'string' ? m.action.trim() : '';
        if (!action) {
            return;
        }

        if (!contextActions.has(action)) {
            return;
        }

        const actor = Users.getUser(state.uid);
        if (!actor || actor.session === undefined) {
            return;
        }

        const payload = {
            action,
            actor: actor.session,
            session: Number(m.session || 0) || null,
            channelId: Number(m.channelId || 0) || null
        };

        log.withDetails('info', payload, 'Context action triggered');
        Users.emit('context_action', payload, state.uid);
    });
}

export function setupBan({ connection, state, ctx: { serverId, channels, aclState, Users, sequelize } }) {
    connection.on('banList', async m => {
        if (!isActiveConnectionState(connection.state)) {
            return;
        }

        const user = Users.getUser(state.uid);
        const rootPermissions = computePermissions(0, user, channels, aclState);
        if ((rootPermissions & PERMISSIONS.Ban) !== PERMISSIONS.Ban) {
            connection.sendMessage('PermissionDenied', {
                type: 1,
                permission: PERMISSIONS.Ban,
                channelId: 0,
                session: user.session,
                reason: 'Permission denied'
            });
            return;
        }

        if (m.query) {
            const bans = await getBans(serverId);
            sendBanList(connection, bans);
            return;
        }

        await sequelize.query(`DELETE FROM bans WHERE server_id = ${Number(serverId)}`);

        if (Array.isArray(m.bans) && m.bans.length > 0) {
            for (const entry of m.bans) {
                await sequelize.query(
                    `INSERT INTO bans (server_id, base, mask, name, hash, reason, start, duration)
                     VALUES (
                        ${Number(serverId)},
                        ${sequelize.escape(entry.address || Buffer.alloc(0))},
                        ${sequelize.escape(Number(entry.mask || 0))},
                        ${sequelize.escape(entry.name || null)},
                        ${sequelize.escape(entry.hash || null)},
                        ${sequelize.escape(entry.reason || null)},
                        ${sequelize.escape(entry.start ? new Date(entry.start) : null)},
                        ${sequelize.escape(Number(entry.duration || 0))}
                     )`
                );
            }
        }
    });
}
