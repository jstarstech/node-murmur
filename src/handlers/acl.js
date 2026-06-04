import {
    computePermissions,
    PERMISSIONS,
    buildAclResponse,
    collectAclUserIds,
    loadAclState,
    saveAclState
} from '../lib/Acl.js';
import { sendQueryUsers } from '../lib/userHelpers.js';

export function setupAcl({
    connection,
    state,
    ctx: { log, serverId, channels, aclState, Users, channelOps, refreshAclState }
}) {
    connection.on('permissionQuery', m => {
        if (connection.state !== 'ready') {
            return;
        }

        const requestedChannelId = Number(m.channelId || 0);
        const user = Users.getUser(state.uid);
        if (!user || user.session === undefined) {
            return;
        }

        const permissions = computePermissions(requestedChannelId, user, channels, aclState);

        connection.sendMessage('PermissionQuery', {
            channelId: requestedChannelId,
            permissions,
            flush: false
        });
    });

    connection.on('acl', m => {
        if (connection.state !== 'ready') {
            return;
        }

        const user = Users.getUser(state.uid);
        const requestedChannelId = Number(m.channelId || 0);

        if (!user || user.session === undefined) {
            return;
        }

        if (!channelOps.canEditAcl(requestedChannelId, user)) {
            connection.sendMessage('PermissionDenied', {
                type: 1,
                permission: PERMISSIONS.Write,
                channelId: requestedChannelId,
                session: user.session,
                reason: 'Permission denied'
            });
            return;
        }

        if (m.query) {
            connection.sendMessage('ACL', buildAclResponse(requestedChannelId, channels, aclState));
            sendQueryUsers(connection, serverId, {
                ids: collectAclUserIds(requestedChannelId, channels, aclState)
            }).catch(err => {
                log.error({ err }, 'Failed to resolve ACL query users');
            });
            return;
        }

        saveAclState(serverId, requestedChannelId, m)
            .then(async () => {
                const refreshedAclState = await loadAclState(serverId);
                refreshAclState(refreshedAclState);

                if (channels[requestedChannelId]) {
                    channels[requestedChannelId].inheritacl = m.inheritAcls !== false ? 1 : 0;
                }
            })
            .catch(err => {
                log.error({ err }, 'Failed to save ACL state');
                connection.sendMessage('PermissionDenied', {
                    type: 0,
                    session: user.session,
                    reason: 'Unable to save ACL'
                });
            });
    });
}
