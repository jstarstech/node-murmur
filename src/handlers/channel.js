import * as util from '../lib/util.js';
import { computePermissions, PERMISSIONS } from '../lib/Acl.js';

export function setupChannel({ connection, state, ctx: { log, Users, channelOps } }) {
    connection.on('channelState', async m => {
        if (connection.state !== 'ready') {
            return;
        }

        const user = Users.getUser(state.uid);
        if (!user || user.session === undefined) {
            return;
        }

        try {
            await channelOps.persistChannelStateChange(user, state.uid, m);
        } catch (err) {
            log.error({ err }, 'Failed to save channel state');

            if (err.code === 'missing_certificate') {
                connection.sendMessage('PermissionDenied', {
                    type: 7,
                    session: user.session,
                    reason: 'Missing certificate'
                });
                return;
            }

            if (err.code === 'channel_name') {
                connection.sendMessage('PermissionDenied', {
                    type: 3,
                    session: user.session,
                    reason: 'Invalid channel name'
                });
                return;
            }

            if (err.code === 'temporary_parent') {
                connection.sendMessage('PermissionDenied', {
                    type: 6,
                    session: user.session,
                    reason: 'Temporary channel'
                });
                return;
            }

            if (err.code === 'permission') {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    permission: err.permission,
                    channelId: err.channelId || 0,
                    session: user.session,
                    reason: 'Permission denied'
                });
                return;
            }

            if (err.code === 'description_too_long') {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    session: user.session,
                    reason: 'Description too long'
                });
                return;
            }

            connection.sendMessage('PermissionDenied', {
                type: 0,
                session: user.session,
                reason: 'Unable to save channel'
            });
        }
    });

    connection.on('channelRemove', async ({ channelId }) => {
        if (connection.state !== 'ready') {
            return;
        }

        const user = Users.getUser(state.uid);
        if (!user || user.session === undefined) {
            return;
        }

        try {
            await channelOps.persistChannelRemoval(user, channelId);
        } catch (err) {
            log.error({ err }, 'Failed to remove channel');

            if (err.code === 'root_remove') {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    permission: PERMISSIONS.Write,
                    channelId: 0,
                    session: user.session,
                    reason: 'Permission denied'
                });
                return;
            }

            if (err.code === 'permission') {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    permission: err.permission,
                    channelId: err.channelId || Number(channelId) || 0,
                    session: user.session,
                    reason: 'Permission denied'
                });
                return;
            }

            connection.sendMessage('PermissionDenied', {
                type: 0,
                session: user.session,
                reason: 'Unable to remove channel'
            });
        }
    });
}

export function setupTextMessage({ connection, state, ctx: { serverConfig, channels, aclState, Users } }) {
    connection.on('textMessage', m => {
        if (connection.state !== 'ready') {
            return;
        }

        const message = m.message;
        if (typeof message !== 'string' || message.length === 0) {
            return;
        }

        const user = Users.getUser(state.uid);
        const sessions = Array.isArray(m.session) ? m.session : [];
        const channelIds = Array.isArray(m.channelId) ? m.channelId : [];
        const treeIds = Array.isArray(m.treeId) ? m.treeId : [];

        let processedMessage = message;
        if (!serverConfig.allowhtml) {
            processedMessage = util.stripHtml(message);
        }

        if (serverConfig.textmessagelength > 0 && processedMessage.length > serverConfig.textmessagelength) {
            connection.sendMessage('PermissionDenied', {
                type: 1,
                reason: 'Message too long'
            });
            return;
        }

        if (processedMessage.length === 0) {
            return;
        }

        if (sessions.length === 0 && channelIds.length === 0 && treeIds.length === 0) {
            return;
        }

        for (const channelId of channelIds) {
            const perms = computePermissions(channelId, user, channels, aclState);
            if ((perms & PERMISSIONS.TextMessage) !== PERMISSIONS.TextMessage) {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    permission: PERMISSIONS.TextMessage,
                    channelId,
                    session: user.session,
                    reason: 'Permission denied'
                });
                return;
            }
        }

        for (const treeId of treeIds) {
            const perms = computePermissions(treeId, user, channels, aclState);
            if ((perms & PERMISSIONS.TextMessage) !== PERMISSIONS.TextMessage) {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    permission: PERMISSIONS.TextMessage,
                    channelId: treeId,
                    session: user.session,
                    reason: 'Permission denied'
                });
                return;
            }
        }

        if (sessions.length > 0) {
            const perms = computePermissions(user.channelId, user, channels, aclState);
            if ((perms & PERMISSIONS.TextMessage) !== PERMISSIONS.TextMessage) {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    permission: PERMISSIONS.TextMessage,
                    channelId: user.channelId,
                    session: user.session,
                    reason: 'Permission denied'
                });
                return;
            }
        }

        const ms = {
            actor: user.session,
            session: sessions,
            channelId: channelIds,
            treeId: treeIds,
            message: processedMessage
        };

        Users.emit('broadcast', 'TextMessage', ms, state.uid);
    });
}
