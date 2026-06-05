import crypto from 'crypto';
import * as util from '../lib/util.js';
import CryptState from '../lib/CryptState.js';
import { computePermissions, canEnterChannel, PERMISSIONS } from '../lib/Acl.js';
import { sendChannelTree, buildChannelStatePayload } from '../lib/channelHelpers.js';
import {
    buildUserStatePayload,
    buildUserStatsPayload,
    createRegisteredUser,
    setUserInfoValue,
    sendRegisteredUsers,
    sendQueryUsers
} from '../lib/userHelpers.js';
import { ipToBuffer } from '../lib/ipUtil.js';
import { buildContextActionModifyPayload, buildCodecVersionPayload } from '../lib/miscPayloads.js';
import { isActiveConnectionState, isVersionNegotiatedState } from '../lib/stateHelpers.js';
import { storeBanEntry, isBanned } from '../lib/banHelpers.js';
import RegisteredUsers from '../models/users.js';
import UserInfo from '../models/user_info.js';

export function setupUser({
    connection,
    socket,
    state,
    ctx: {
        log,
        serverId,
        serverConfig,
        channels,
        aclState,
        Users,
        connectionsBySession,
        codecState,
        codecNegotiation,
        contextActions,
        formatUserLogPrefix,
        logRejectedConnection,
        findUserBySession,
        getLiveUserCount
    }
}) {
    function disconnectLiveSessionsByRegisteredUserId(userId) {
        const targetUserId = Number(userId);

        for (const user of Object.values(Users.users)) {
            if (!user || Number(user.userId) !== targetUserId) {
                continue;
            }

            const tempConnection = connectionsBySession.get(user.session);
            if (!tempConnection) {
                continue;
            }

            tempConnection.removalInfo = {
                actor: null,
                reason: 'Removed by administrator',
                ban: false
            };
            tempConnection.disconnect();
        }
    }

    connection.on('queryUsers', async m => {
        if (!isActiveConnectionState(connection.state)) {
            return;
        }

        await sendQueryUsers(connection, serverId, m);
    });

    connection.on('userList', async m => {
        if (!isActiveConnectionState(connection.state)) {
            return;
        }

        if (!Array.isArray(m.users) || m.users.length === 0) {
            await sendRegisteredUsers(connection, serverId, m);
            return;
        }

        for (const entry of m.users) {
            const userId = Number(entry.userId || 0);
            if (userId === 0) {
                continue;
            }

            if (entry.name === undefined || entry.name === null || String(entry.name).trim().length === 0) {
                disconnectLiveSessionsByRegisteredUserId(userId);

                await RegisteredUsers.destroy({
                    where: {
                        server_id: serverId,
                        user_id: userId
                    }
                });

                await UserInfo.destroy({
                    where: {
                        server_id: serverId,
                        user_id: userId,
                        key: 3
                    }
                });
                continue;
            }

            await RegisteredUsers.update(
                {
                    name: entry.name
                },
                {
                    where: {
                        server_id: serverId,
                        user_id: userId
                    }
                }
            );
        }

        await sendRegisteredUsers(connection, serverId, {});
    });

    connection.on('userRemove', async m => {
        if (!isActiveConnectionState(connection.state)) {
            return;
        }

        const actor = Users.getUser(state.uid);
        if (!actor || actor.session === undefined) {
            return;
        }

        const targetSession = Number(m.session || 0);
        if (!Number.isFinite(targetSession) || targetSession === 0) {
            return;
        }

        const targetConnection = connectionsBySession.get(targetSession);
        const targetUser = findUserBySession(targetSession);
        if (!targetConnection || !targetUser || targetUser.session === undefined) {
            return;
        }

        const rootPermissions = computePermissions(0, actor, channels, aclState);
        const perm = m.ban ? PERMISSIONS.Ban : PERMISSIONS.Kick;

        if (targetUser.userId === 0 || (rootPermissions & perm) !== perm) {
            connection.sendMessage('PermissionDenied', {
                type: 1,
                permission: perm,
                channelId: 0,
                session: actor.session,
                reason: 'Permission denied'
            });
            return;
        }

        if (m.ban) {
            const remoteAddress = targetConnection.socket?.socket?.remoteAddress || '';
            const banRow = {
                address: ipToBuffer(remoteAddress),
                mask: 128,
                name: targetUser.name || undefined,
                hash: targetUser.hash || undefined,
                reason: m.reason || undefined,
                start: new Date().toISOString(),
                duration: 0
            };

            try {
                await storeBanEntry(serverId, banRow);
            } catch (err) {
                log.error({ err }, 'Failed to store ban entry');
                connection.sendMessage('PermissionDenied', {
                    type: 0,
                    session: actor.session,
                    reason: 'Unable to save ban'
                });
                return;
            }
        }

        targetConnection.removalInfo = {
            actor: actor.session,
            reason: m.reason || undefined,
            ban: Boolean(m.ban)
        };
        targetConnection.disconnect();
    });

    connection.on('requestBlob', async m => {
        if (!isActiveConnectionState(connection.state)) {
            return;
        }

        const requestedTextures = Array.isArray(m.sessionTexture) ? m.sessionTexture : [];
        for (const session of requestedTextures) {
            const target = findUserBySession(Number(session));
            if (!target || !target.texture || target.texture.length === 0) {
                continue;
            }

            connection.sendMessage('UserState', {
                session: target.session,
                texture: target.texture
            });
        }

        const requestedComments = Array.isArray(m.sessionComment) ? m.sessionComment : [];
        for (const session of requestedComments) {
            const target = findUserBySession(Number(session));
            if (!target || target.comment === null || target.comment === undefined) {
                continue;
            }

            connection.sendMessage('UserState', {
                session: target.session,
                comment: target.comment.length === 0 ? '' : target.comment
            });
        }

        const requestedDescriptions = Array.isArray(m.channelDescription) ? m.channelDescription : [];
        for (const channelId of requestedDescriptions) {
            const channel = channels[Number(channelId)];
            if (!channel || !channel.description) {
                continue;
            }

            connection.sendMessage('ChannelState', {
                ...buildChannelStatePayload(channel, connection.clientVersion, { includeDescription: true })
            });
        }
    });

    connection.on('userStats', async m => {
        if (!isActiveConnectionState(connection.state)) {
            return;
        }

        const requester = Users.getUser(state.uid);
        if (!requester || requester.session === undefined) {
            return;
        }

        const targetSession = Number(m.session || 0);
        if (!Number.isFinite(targetSession) || targetSession === 0) {
            return;
        }

        const targetConnection = connectionsBySession.get(targetSession);
        const targetUser = findUserBySession(targetSession);
        if (!targetConnection || !targetUser || targetUser.session === undefined) {
            return;
        }

        const rootPermissions = computePermissions(0, requester, channels, aclState);
        const extended =
            requester.session === targetUser.session ||
            (rootPermissions & PERMISSIONS.Register) === PERMISSIONS.Register;

        if (!extended && !canEnterChannel(targetUser.channelId, requester, channels, aclState)) {
            connection.sendMessage('PermissionDenied', {
                type: 1,
                permission: PERMISSIONS.Enter,
                channelId: targetUser.channelId || 0,
                session: requester.session,
                reason: 'Permission denied'
            });
            return;
        }

        connection.sendMessage(
            'UserStats',
            buildUserStatsPayload(targetUser, targetConnection, {
                statsOnly: m.statsOnly === true,
                extended,
                local: extended || targetUser.channelId === requester.channelId
            })
        );
    });

    async function handleUserState(m) {
        const actor = Users.getUser(state.uid);
        if (!actor || actor.session === undefined) {
            return;
        }

        let targetUserId = state.uid;
        let target = actor;

        if (Object.prototype.hasOwnProperty.call(m, 'session') && m.session !== null && m.session !== undefined) {
            const requestedSession = Number(m.session);
            if (!Number.isFinite(requestedSession) || requestedSession <= 0) {
                return;
            }

            const targetEntry = Object.entries(Users.users).find(([, candidate]) => {
                return candidate && candidate.session === requestedSession;
            });

            if (!targetEntry) {
                return;
            }

            targetUserId = Number(targetEntry[0]);
            target = targetEntry[1];
        }

        const updateUserState = {
            session: target.session || null,
            actor: actor.session || null
        };
        const textureProvided = Object.prototype.hasOwnProperty.call(m, 'texture');
        const commentProvided = Object.prototype.hasOwnProperty.call(m, 'comment');

        if (Object.prototype.hasOwnProperty.call(m, 'userId') && m.userId !== null && m.userId !== undefined) {
            if (target.userId !== null && target.userId !== undefined) {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    permission: PERMISSIONS.SelfRegister,
                    channelId: 0,
                    session: actor.session,
                    reason: 'Already registered'
                });
                return;
            }

            if (!target.hash) {
                connection.sendMessage('PermissionDenied', {
                    type: 7,
                    session: actor.session,
                    reason: 'Missing certificate'
                });
                return;
            }

            const rootPermissions = computePermissions(0, actor, channels, aclState);
            const requiredPermission = target === actor ? PERMISSIONS.SelfRegister : PERMISSIONS.Register;
            if ((rootPermissions & requiredPermission) !== requiredPermission) {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    permission: requiredPermission,
                    channelId: 0,
                    session: actor.session,
                    reason: 'Permission denied'
                });
                return;
            }

            try {
                const registeredUserId = await createRegisteredUser(serverId, target, target.hash);
                const updatedUser = await Users.updateUser(targetUserId, {
                    userId: registeredUserId
                });

                Users.emit('broadcast', 'UserState', updatedUser, targetUserId);
            } catch (err) {
                log.error({ err }, 'Failed to register user');
                connection.sendMessage('PermissionDenied', {
                    type: 0,
                    session: actor.session,
                    reason: 'Unable to register user'
                });
            }

            return;
        }

        if (Object.prototype.hasOwnProperty.call(m, 'deaf') && m.deaf !== target.deaf) {
            updateUserState.deaf = m.deaf;
        }

        if (Object.prototype.hasOwnProperty.call(m, 'mute') && m.mute !== target.mute) {
            updateUserState.mute = m.mute;
        }

        if (Object.prototype.hasOwnProperty.call(m, 'recording') && m.recording !== target.recording) {
            updateUserState.recording = m.recording;
        }

        if (Object.prototype.hasOwnProperty.call(m, 'suppress') && m.suppress !== target.suppress) {
            updateUserState.suppress = m.suppress;
        }

        if (Object.prototype.hasOwnProperty.call(m, 'selfMute') && m.selfMute !== target.selfMute) {
            updateUserState.selfMute = m.selfMute;
        }

        if (Object.prototype.hasOwnProperty.call(m, 'selfDeaf') && m.selfDeaf !== target.selfDeaf) {
            updateUserState.selfDeaf = m.selfDeaf;
        }

        if (Object.prototype.hasOwnProperty.call(m, 'channelId') && m.channelId !== target.channelId) {
            updateUserState.channelId = m.channelId;
        }

        if (
            Object.prototype.hasOwnProperty.call(m, 'prioritySpeaker') &&
            m.prioritySpeaker !== target.prioritySpeaker
        ) {
            updateUserState.prioritySpeaker = m.prioritySpeaker;
        }

        if (Object.prototype.hasOwnProperty.call(m, 'pluginIdentity') && m.pluginIdentity !== target.pluginIdentity) {
            updateUserState.pluginIdentity = m.pluginIdentity;
        }

        if (Object.prototype.hasOwnProperty.call(m, 'pluginContext') && m.pluginContext !== target.pluginContext) {
            updateUserState.pluginContext = m.pluginContext;
        }

        if (
            target !== actor &&
            (Object.prototype.hasOwnProperty.call(updateUserState, 'mute') ||
                Object.prototype.hasOwnProperty.call(updateUserState, 'deaf') ||
                Object.prototype.hasOwnProperty.call(updateUserState, 'suppress') ||
                Object.prototype.hasOwnProperty.call(updateUserState, 'prioritySpeaker'))
        ) {
            const rootPermissions = computePermissions(Number(target.channelId || 0), actor, channels, aclState);
            const requiresMuteDeafen = (rootPermissions & PERMISSIONS.MuteDeafen) === PERMISSIONS.MuteDeafen;

            if (target.userId === 0 || !requiresMuteDeafen) {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    permission: PERMISSIONS.MuteDeafen,
                    channelId: Number(target.channelId || 0),
                    session: actor.session,
                    reason: 'Permission denied'
                });
                return;
            }

            if (Object.prototype.hasOwnProperty.call(updateUserState, 'suppress')) {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    permission: PERMISSIONS.MuteDeafen,
                    channelId: Number(target.channelId || 0),
                    session: actor.session,
                    reason: 'Permission denied'
                });
                return;
            }
        }

        if (
            state.auth === true &&
            Object.prototype.hasOwnProperty.call(updateUserState, 'channelId') &&
            updateUserState.channelId !== target.channelId
        ) {
            const requestedChannelId = Number(updateUserState.channelId);
            const destinationChannel = channels[requestedChannelId];

            if (!destinationChannel) {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    permission: PERMISSIONS.Enter,
                    channelId: requestedChannelId,
                    session: actor.session,
                    reason: 'Unknown channel'
                });
                return;
            }

            if (target !== actor) {
                const actorPermissions = computePermissions(Number(target.channelId || 0), actor, channels, aclState);
                if ((actorPermissions & PERMISSIONS.Move) !== PERMISSIONS.Move) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: PERMISSIONS.Move,
                        channelId: Number(target.channelId || 0),
                        session: actor.session,
                        reason: 'Permission denied'
                    });
                    return;
                }
            }

            const destinationPermissions = computePermissions(requestedChannelId, actor, channels, aclState);
            const actorCanMoveHere = (destinationPermissions & PERMISSIONS.Move) === PERMISSIONS.Move;
            const targetCanEnterDestination = canEnterChannel(requestedChannelId, target, channels, aclState);

            if (!actorCanMoveHere && !targetCanEnterDestination) {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    permission: PERMISSIONS.Enter,
                    channelId: requestedChannelId,
                    session: actor.session,
                    reason: 'Permission denied'
                });
                return;
            }
        }

        if (textureProvided) {
            const texture = Buffer.isBuffer(m.texture)
                ? Buffer.from(m.texture)
                : m.texture
                  ? Buffer.from(m.texture)
                  : Buffer.alloc(0);

            if (texture.length === 0) {
                if (target.userId !== null && target.userId !== undefined) {
                    await RegisteredUsers.update(
                        {
                            texture: null
                        },
                        {
                            where: {
                                server_id: serverId,
                                user_id: target.userId
                            }
                        }
                    );
                }

                updateUserState.texture = Buffer.alloc(0);
                updateUserState.textureHash = Buffer.alloc(0);
            } else {
                if (serverConfig.imagemessagelength > 0 && texture.length > serverConfig.imagemessagelength) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        session: actor.session,
                        reason: 'Image too big'
                    });
                    return;
                }

                if (target.userId !== null && target.userId !== undefined) {
                    await RegisteredUsers.update(
                        {
                            texture
                        },
                        {
                            where: {
                                server_id: serverId,
                                user_id: target.userId
                            }
                        }
                    );
                }

                updateUserState.texture = texture;
                updateUserState.textureHash = crypto.createHash('sha1').update(texture).digest();
            }
        }

        if (commentProvided) {
            let comment = typeof m.comment === 'string' ? m.comment : '';

            if (!serverConfig.allowhtml) {
                comment = util.stripHtml(comment);
            }

            if (serverConfig.textmessagelength > 0 && comment.length > serverConfig.textmessagelength) {
                connection.sendMessage('PermissionDenied', {
                    type: 1,
                    reason: 'Comment too long'
                });
                return;
            }

            if (comment.length === 0) {
                if (target.userId !== null && target.userId !== undefined) {
                    await setUserInfoValue(serverId, target.userId, 2, null);
                }

                updateUserState.comment = '';
                updateUserState.commentHash = Buffer.alloc(0);
            } else {
                if (target.userId !== null && target.userId !== undefined) {
                    await setUserInfoValue(serverId, target.userId, 2, comment);
                }

                updateUserState.comment = comment;
                updateUserState.commentHash = crypto.createHash('sha1').update(comment).digest();
            }
        }

        await Users.updateUser(targetUserId, updateUserState);
        Users.emit('broadcast', 'UserState', updateUserState, targetUserId);
    }

    connection.on('userState', m => {
        if (!state.ready) {
            state.pendingUserStates.push(m);
            return;
        }

        handleUserState(m);
    });

    connection.on('authenticate', async m => {
        if (!isVersionNegotiatedState(connection.state)) {
            return;
        }

        connection.state = 'authenticating';
        state.attemptedUsername = m.username || '';
        const peerCertificate = socket.getPeerCertificate();
        const certificateHash =
            peerCertificate && typeof peerCertificate.fingerprint === 'string'
                ? peerCertificate.fingerprint.replace(/:/g, '').toLowerCase()
                : null;

        if (serverConfig.certrequired && !certificateHash) {
            const reject = {
                type: 7,
                reason: 'No certificate'
            };
            logRejectedConnection(m.username, reject);
            connection.sendMessage('Reject', reject);
            connection.disconnect();
            return;
        }

        const banned = certificateHash ? await isBanned(serverId, null, certificateHash) : null;
        if (banned) {
            const reject = {
                type: 1,
                reason: banned.reason || 'Banned'
            };
            logRejectedConnection(m.username, reject);
            connection.sendMessage('Reject', reject);
            connection.disconnect();
            return;
        }

        const authResult = await Users.addUser(
            {
                name: m.username,
                password: m.password,
                opus: m.opus,
                hash: certificateHash,
                channelId: serverConfig.defaultchannel
            },
            { allocateSession: false }
        );

        connection.clientCeltVersions = Array.isArray(m.celtVersions) ? m.celtVersions.slice() : [];
        connection.clientOpus = Boolean(m.opus);

        if (authResult.reject) {
            await Users.deleteUser(authResult.id);
            logRejectedConnection(m.username, authResult.reject);
            connection.sendMessage('Reject', authResult.reject);
            connection.disconnect();
            return;
        }

        if (serverConfig.users > 0 && getLiveUserCount() >= serverConfig.users && m.username !== 'SuperUser') {
            const rejectedUser = Users.getUser(authResult.id);
            const rejectedSessionId = rejectedUser.session;

            await Users.deleteUser(authResult.id);
            if (rejectedSessionId !== undefined && rejectedSessionId !== null) {
                Users.releaseSession(rejectedSessionId);
            }

            const reject = {
                type: 6,
                reason: 'Server full'
            };
            logRejectedConnection(m.username, reject);
            connection.sendMessage('Reject', reject);
            connection.disconnect();
            return;
        }

        const pendingUser = Users.getUser(authResult.id);
        pendingUser.session = connection.sessionId;
        const activeUser = Users.activateUser(authResult.id);

        state.uid = authResult.id;
        connection.state = 'authenticated';

        state.auth = true;

        connection.sessionId = activeUser.session;
        connectionsBySession.set(connection.sessionId, connection);

        const negotiatedMode =
            connection.clientCryptoModes.find(mode => CryptState.supportedModes().includes(mode)) ||
            CryptState.supportedModes()[0];
        connection.cryptState = new CryptState(negotiatedMode);
        connection.cryptState.generateKey(negotiatedMode);

        log.info(`${formatUserLogPrefix(activeUser)} Authenticated`);

        connection.sendMessage('CryptSetup', connection.cryptState.getCryptSetup());

        const rootChannel = channels[0];
        sendChannelTree(connection, channels, rootChannel);

        const initialUserState = buildUserStatePayload(activeUser, connection.clientVersion, {
            includeBlobs: false,
            includeActor: false,
            includeUnsetFlags: false
        });

        Users.emit('broadcast', 'UserState', initialUserState, state.uid);

        for (const item of Object.values(Users.users)) {
            if (item.session === connection.sessionId) {
                continue;
            }

            const targetConnection = connectionsBySession.get(item.session);
            if (!targetConnection || targetConnection.state !== 'ready') {
                continue;
            }

            connection.sendMessage(
                'UserState',
                buildUserStatePayload(item, connection.clientVersion, {
                    includeBlobs: false,
                    includeActor: false,
                    includeUnsetFlags: false
                })
            );
        }

        connection.sendMessage('ServerSync', {
            session: activeUser.session,
            maxBandwidth: serverConfig.bandwidth,
            welcomeText: serverConfig.welcometext,
            permissions: computePermissions(0, activeUser, channels, aclState)
        });

        connection.sendMessage('ServerConfig', {
            maxBandwidth: null,
            welcomeText: null,
            allowHtml: Boolean(serverConfig.allowhtml),
            messageLength: serverConfig.textmessagelength,
            imageMessageLength: serverConfig.imagemessagelength
        });

        const codecChanged = codecNegotiation.updateCodecVersions(connection);
        if (!codecChanged) {
            connection.sendMessage('CodecVersion', buildCodecVersionPayload(codecState));
        }

        for (const [action, entry] of contextActions.entries()) {
            connection.sendMessage('ContextActionModify', buildContextActionModifyPayload(action, entry, 0));
        }

        while (state.pendingUserStates.length > 0) {
            await handleUserState(state.pendingUserStates.shift());
        }

        state.ready = true;
        connection.state = 'ready';
    });
}
