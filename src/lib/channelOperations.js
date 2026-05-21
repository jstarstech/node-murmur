import { PERMISSIONS, computePermissions, loadAclState } from './Acl.js';
import { getChannels, loadChannelLinks, setChannelDescriptionValue } from './channelHelpers.js';
import { stripHtml } from './util.js';

export function createChannelOperations({
    serverId,
    channels,
    aclState,
    serverConfig,
    channelNameValidator,
    sequelize,
    Users,
    refreshAclState,
    broadcastChannelState
}) {
    function canEditAcl(channelId, user) {
        const requestedChannelId = Number(channelId);
        const channel = channels[requestedChannelId];

        if (!channel) {
            return false;
        }

        const currentPermissions = computePermissions(requestedChannelId, user, channels, aclState);
        if ((currentPermissions & PERMISSIONS.Write) === PERMISSIONS.Write) {
            return true;
        }

        const parentId = channel.parent_id;
        if (parentId === null || parentId === undefined) {
            return false;
        }

        const parentPermissions = computePermissions(Number(parentId), user, channels, aclState);
        return (parentPermissions & PERMISSIONS.Write) === PERMISSIONS.Write;
    }

    async function syncChannelLinks(channelId, nextLinkIds, transaction) {
        const serverIdNum = Number(serverId);
        const channelIdNum = Number(channelId);
        const normalizedNextLinks = [
            ...new Set(nextLinkIds.map(id => Number(id)).filter(id => Number.isFinite(id)))
        ].filter(id => {
            return id !== channelIdNum && Boolean(channels[id]);
        });

        const [rows] = await sequelize.query(
            `SELECT channel_id, link_id
             FROM channel_links
             WHERE server_id = ?
               AND (channel_id = ? OR link_id = ?)`,
            { replacements: [serverIdNum, channelIdNum, channelIdNum], transaction }
        );

        const currentLinks = new Set();
        for (const row of rows || []) {
            const otherId = Number(row.channel_id) === channelIdNum ? Number(row.link_id) : Number(row.channel_id);
            if (Number.isFinite(otherId) && otherId !== channelIdNum) {
                currentLinks.add(otherId);
            }
        }

        for (const otherId of currentLinks) {
            if (normalizedNextLinks.includes(otherId)) {
                continue;
            }

            const minId = Math.min(channelIdNum, otherId);
            const maxId = Math.max(channelIdNum, otherId);
            await sequelize.query(
                `DELETE FROM channel_links
                 WHERE server_id = ?
                   AND channel_id = ?
                   AND link_id = ?`,
                { replacements: [serverIdNum, minId, maxId], transaction }
            );
        }

        for (const otherId of normalizedNextLinks) {
            if (currentLinks.has(otherId)) {
                continue;
            }

            const minId = Math.min(channelIdNum, otherId);
            const maxId = Math.max(channelIdNum, otherId);
            await sequelize.query(
                `INSERT INTO channel_links (server_id, channel_id, link_id)
                 SELECT ?, ?, ?
                 WHERE NOT EXISTS (
                     SELECT 1
                     FROM channel_links
                     WHERE server_id = ?
                     AND channel_id = ?
                       AND link_id = ?
                 )`,
                { replacements: [serverIdNum, minId, maxId, serverIdNum, minId, maxId], transaction }
            );
        }
    }

    async function setChannelInfoValue(channelId, key, value, transaction) {
        await sequelize.query(
            `DELETE FROM channel_info
             WHERE server_id = ?
               AND channel_id = ?
               AND key = ?`,
            { replacements: [Number(serverId), Number(channelId), Number(key)], transaction }
        );

        if (value === null || value === undefined) {
            return;
        }

        await sequelize.query(
            `INSERT INTO channel_info (server_id, channel_id, key, value)
             VALUES (?, ?, ?, ?)`,
            { replacements: [Number(serverId), Number(channelId), Number(key), value], transaction }
        );
    }

    async function persistChannelStateChange(user, userId, m) {
        const hasChannelId =
            Object.prototype.hasOwnProperty.call(m, 'channelId') && m.channelId !== null && m.channelId !== undefined;
        const isCreate = !hasChannelId;
        const requestedChannelId = hasChannelId ? Number(m.channelId) : null;
        const nameProvided = Object.prototype.hasOwnProperty.call(m, 'name');
        const targetName = nameProvided && typeof m.name === 'string' ? m.name : null;
        const targetParentId = Object.prototype.hasOwnProperty.call(m, 'parent') ? Number(m.parent) : null;
        const temporaryProvided = Object.prototype.hasOwnProperty.call(m, 'temporary');
        const isTemporary = temporaryProvided ? Boolean(m.temporary) : false;
        const descriptionProvided = Object.prototype.hasOwnProperty.call(m, 'description');
        let descriptionValue = descriptionProvided && typeof m.description === 'string' ? m.description : null;

        if (descriptionProvided && !serverConfig.allowhtml && descriptionValue) {
            descriptionValue = stripHtml(descriptionValue);
        }

        if (
            descriptionValue &&
            serverConfig.textmessagelength > 0 &&
            descriptionValue.length > serverConfig.textmessagelength
        ) {
            const error = new Error('Description too long');
            error.code = 'description_too_long';
            throw error;
        }

        const positionProvided = Object.prototype.hasOwnProperty.call(m, 'position');
        const linksProvided = Array.isArray(m.linksAdd) || Array.isArray(m.linksRemove);
        const currentChannel = isCreate ? null : channels[requestedChannelId];

        if (isCreate) {
            if (targetParentId === null || targetParentId === undefined || !Number.isFinite(targetParentId)) {
                throw new Error('Invalid parent channel');
            }

            if (!nameProvided || !targetName || !channelNameValidator.test(targetName)) {
                throw new Error('Invalid channel name');
            }

            const parentChannel = channels[targetParentId];
            if (!parentChannel) {
                throw new Error('Invalid parent channel');
            }

            const requiredPermission = isTemporary ? PERMISSIONS.MakeTempChannel : PERMISSIONS.MakeChannel;
            const parentPermissions = computePermissions(targetParentId, user, channels, aclState);
            if ((parentPermissions & requiredPermission) !== requiredPermission) {
                const error = new Error('Permission denied');
                error.code = 'permission';
                error.permission = requiredPermission;
                error.channelId = targetParentId;
                throw error;
            }

            if (!user.hash && (user.userId === null || user.userId === undefined)) {
                const error = new Error('Missing certificate');
                error.code = 'missing_certificate';
                throw error;
            }

            if (parentChannel.temporary) {
                const error = new Error('Temporary channel');
                error.code = 'temporary_parent';
                throw error;
            }

            const siblingExists = Object.values(channels).some(channel => {
                return (
                    Number(channel.parent_id) === targetParentId &&
                    typeof channel.name === 'string' &&
                    channel.name === targetName
                );
            });
            if (siblingExists) {
                const error = new Error('Channel name already exists');
                error.code = 'channel_name';
                throw error;
            }

            const createdChannel = await sequelize.transaction(async transaction => {
                const [rows] = await sequelize.query(
                    `SELECT COALESCE(MAX(channel_id), 0) AS max_channel_id
                     FROM channels
                     WHERE server_id = ?`,
                    { replacements: [Number(serverId)], transaction }
                );
                const nextChannelId = Number(rows?.[0]?.max_channel_id || 0) + 1;

                await sequelize.query(
                    `INSERT INTO channels (server_id, channel_id, parent_id, name, inheritacl, temporary)
                     VALUES (?, ?, ?, ?, 1, ?)`,
                    {
                        replacements: [
                            Number(serverId),
                            Number(nextChannelId),
                            Number(targetParentId),
                            targetName,
                            isTemporary ? 1 : 0
                        ],
                        transaction
                    }
                );

                await setChannelDescriptionValue(serverId, nextChannelId, descriptionValue, transaction);
                if (positionProvided) {
                    await setChannelInfoValue(nextChannelId, 1, Number(m.position || 0), transaction);
                }

                if (user.userId !== null && user.userId !== undefined) {
                    await sequelize.query(
                        `INSERT INTO "groups" (server_id, name, channel_id, inherit, inheritable)
                         VALUES (?, 'admin', ?, 1, 1)`,
                        { replacements: [Number(serverId), Number(nextChannelId)], transaction }
                    );

                    await sequelize.query(
                        `INSERT INTO group_members (group_id, server_id, user_id, addit)
                         VALUES (
                            (SELECT group_id FROM "groups" WHERE server_id = ? AND channel_id = ? AND name = 'admin' LIMIT 1),
                            ?, ?, 1
                         )`,
                        {
                            replacements: [
                                Number(serverId),
                                Number(nextChannelId),
                                Number(serverId),
                                Number(user.userId)
                            ],
                            transaction
                        }
                    );
                } else if (user.hash) {
                    await sequelize.query(
                        `INSERT INTO acl (server_id, channel_id, priority, user_id, group_name, apply_here, apply_sub, grantpriv, revokepriv)
                         VALUES (?, ?, 1, NULL, ?, 1, 1, ?, 0)`,
                        {
                            replacements: [
                                Number(serverId),
                                Number(nextChannelId),
                                `$${user.hash}`,
                                PERMISSIONS.Write | PERMISSIONS.Traverse
                            ],
                            transaction
                        }
                    );
                }

                const created = {
                    channel_id: nextChannelId,
                    parent_id: targetParentId,
                    name: targetName,
                    description: descriptionValue || '',
                    position: positionProvided ? Number(m.position || 0) : 0,
                    temporary: isTemporary ? 1 : 0,
                    links: new Set()
                };

                return created;
            });

            const refreshedChannels = await getChannels(serverId);
            await loadChannelLinks(serverId, refreshedChannels);
            for (const key of Object.keys(channels)) {
                delete channels[key];
            }
            Object.assign(channels, refreshedChannels);

            const refreshedAclState = await loadAclState(serverId);
            refreshAclState(refreshedAclState);

            const refreshedChannel = channels[createdChannel.channel_id];

            if (refreshedChannel) {
                broadcastChannelState(refreshedChannel);
            }

            if (createdChannel.temporary) {
                const updatedUser = await Users.updateUser(userId, {
                    channelId: createdChannel.channel_id
                });
                Users.emit(
                    'broadcast',
                    'UserState',
                    {
                        session: updatedUser.session,
                        channelId: updatedUser.channelId
                    },
                    userId
                );
            }
            return;
        }

        if (!currentChannel) {
            throw new Error('Invalid channel');
        }

        if (nameProvided && (targetName === null || !channelNameValidator.test(targetName))) {
            throw new Error('Invalid channel name');
        }

        const currentPermissions = computePermissions(requestedChannelId, user, channels, aclState);
        if (nameProvided || descriptionProvided || positionProvided || linksProvided || targetParentId !== null) {
            if ((currentPermissions & PERMISSIONS.Write) !== PERMISSIONS.Write) {
                const error = new Error('Permission denied');
                error.code = 'permission';
                error.permission = PERMISSIONS.Write;
                error.channelId = requestedChannelId;
                throw error;
            }
        }

        if (linksProvided && (currentPermissions & PERMISSIONS.LinkChannel) !== PERMISSIONS.LinkChannel) {
            const error = new Error('Permission denied');
            error.code = 'permission';
            error.permission = PERMISSIONS.LinkChannel;
            error.channelId = requestedChannelId;
            throw error;
        }

        if (linksProvided) {
            for (const linkId of Array.isArray(m.linksAdd) ? m.linksAdd : []) {
                const linkedChannel = channels[Number(linkId)];
                if (!linkedChannel) {
                    continue;
                }

                const linkedPermissions = computePermissions(Number(linkId), user, channels, aclState);
                if ((linkedPermissions & PERMISSIONS.LinkChannel) !== PERMISSIONS.LinkChannel) {
                    const error = new Error('Permission denied');
                    error.code = 'permission';
                    error.permission = PERMISSIONS.LinkChannel;
                    error.channelId = Number(linkId);
                    throw error;
                }
            }
        }

        const currentParentId =
            currentChannel.parent_id === null || currentChannel.parent_id === undefined
                ? null
                : Number(currentChannel.parent_id);
        const normalizeParentId = value => (value === null || value === undefined ? null : Number(value));
        const nextParentId = targetParentId !== null ? targetParentId : currentParentId;
        const parentChanged = targetParentId !== null && Number(targetParentId) !== Number(currentParentId);
        const nextName = nameProvided ? targetName : currentChannel.name;
        const nextTemporary = Boolean(currentChannel.temporary);

        const parentChannel =
            nextParentId === null || nextParentId === undefined ? null : channels[Number(nextParentId)];
        if (parentChanged) {
            if (!parentChannel) {
                throw new Error('Invalid parent channel');
            }

            if (parentChannel.temporary) {
                const error = new Error('Temporary channel');
                error.code = 'temporary_parent';
                throw error;
            }

            let iter = parentChannel;
            while (iter) {
                if (Number(iter.channel_id) === requestedChannelId) {
                    throw new Error('Illegal channel reparent');
                }
                iter =
                    iter.parent_id !== null && iter.parent_id !== undefined ? channels[Number(iter.parent_id)] : null;
            }

            const parentPermissions = computePermissions(nextParentId, user, channels, aclState);
            if ((parentPermissions & PERMISSIONS.MakeChannel) !== PERMISSIONS.MakeChannel) {
                const error = new Error('Permission denied');
                error.code = 'permission';
                error.permission = PERMISSIONS.MakeChannel;
                error.channelId = nextParentId;
                throw error;
            }
        }

        const siblingExists = Object.values(channels).some(channel => {
            return (
                Number(channel.channel_id) !== requestedChannelId &&
                normalizeParentId(channel.parent_id) === nextParentId &&
                typeof channel.name === 'string' &&
                channel.name === nextName
            );
        });
        if (siblingExists) {
            const error = new Error('Channel name already exists');
            error.code = 'channel_name';
            throw error;
        }

        const updatedChannel = await sequelize.transaction(async transaction => {
            await sequelize.query(
                `UPDATE channels
                 SET parent_id = ?,
                     name = ?,
                     temporary = ?
                 WHERE server_id = ?
                   AND channel_id = ?`,
                {
                    replacements: [
                        nextParentId === null || nextParentId === undefined ? null : Number(nextParentId),
                        nextName,
                        nextTemporary ? 1 : 0,
                        Number(serverId),
                        Number(requestedChannelId)
                    ],
                    transaction
                }
            );

            if (descriptionProvided) {
                await setChannelDescriptionValue(serverId, requestedChannelId, descriptionValue, transaction);
            }

            if (positionProvided) {
                await setChannelInfoValue(requestedChannelId, 1, Number(m.position || 0), transaction);
            }

            if (linksProvided) {
                const currentLinks = new Set(currentChannel.links instanceof Set ? [...currentChannel.links] : []);
                for (const linkId of Array.isArray(m.linksRemove) ? m.linksRemove : []) {
                    currentLinks.delete(Number(linkId));
                }
                for (const linkId of Array.isArray(m.linksAdd) ? m.linksAdd : []) {
                    currentLinks.add(Number(linkId));
                }
                currentLinks.delete(requestedChannelId);
                await syncChannelLinks(requestedChannelId, [...currentLinks], transaction);
            }

            return currentChannel;
        });

        const refreshedChannels = await getChannels(serverId);
        await loadChannelLinks(serverId, refreshedChannels);
        for (const key of Object.keys(channels)) {
            delete channels[key];
        }
        Object.assign(channels, refreshedChannels);

        const refreshedAclState = await loadAclState(serverId);
        refreshAclState(refreshedAclState);

        broadcastChannelState(channels[Number(updatedChannel.channel_id)]);
    }

    function isChannelDescendantOf(channelId, ancestorId) {
        let current = channels[Number(channelId)];
        const target = Number(ancestorId);
        while (current) {
            if (Number(current.channel_id) === target) {
                return true;
            }
            if (current.parent_id === null || current.parent_id === undefined) {
                break;
            }
            current = channels[Number(current.parent_id)];
        }
        return false;
    }

    function collectChannelSubtree(channelId) {
        const targetId = Number(channelId);
        const ordered = [];

        const walk = currentId => {
            const children = Object.values(channels)
                .filter(channel => Number(channel.parent_id) === Number(currentId))
                .sort((left, right) => {
                    const leftPos = Number.isFinite(Number(left.position)) ? Number(left.position) : 0;
                    const rightPos = Number.isFinite(Number(right.position)) ? Number(right.position) : 0;
                    if (leftPos !== rightPos) {
                        return leftPos - rightPos;
                    }

                    return Number(left.channel_id) - Number(right.channel_id);
                });

            for (const child of children) {
                walk(Number(child.channel_id));
            }

            ordered.push(Number(currentId));
        };

        walk(targetId);
        return ordered;
    }

    function findChannelRemovalTarget(channel, movingUser) {
        let target = channels[Number(channel.parent_id)];

        while (target && target.parent_id !== null && target.parent_id !== undefined) {
            const targetPermissions = computePermissions(Number(target.channel_id), movingUser, channels, aclState);
            if ((targetPermissions & PERMISSIONS.Enter) === PERMISSIONS.Enter) {
                break;
            }

            target = channels[Number(target.parent_id)];
        }

        return target || channels[0];
    }

    async function persistChannelRemoval(user, channelId) {
        const rootChannelId = Number(channelId);
        const channel = channels[rootChannelId];

        if (!channel) {
            return { removedIds: [] };
        }

        if (rootChannelId === 0) {
            const error = new Error('Root channel cannot be removed');
            error.code = 'root_remove';
            throw error;
        }

        const currentPermissions = computePermissions(rootChannelId, user, channels, aclState);
        if ((currentPermissions & PERMISSIONS.Write) !== PERMISSIONS.Write) {
            const error = new Error('Permission denied');
            error.code = 'permission';
            error.permission = PERMISSIONS.Write;
            error.channelId = rootChannelId;
            throw error;
        }

        const removedIds = collectChannelSubtree(rootChannelId);
        const movedUsers = Object.entries(Users.users)
            .map(([id, item]) => ({ id: Number(id), item }))
            .filter(({ item }) => removedIds.includes(Number(item.channelId)));

        await sequelize.transaction(async transaction => {
            const numericIds = removedIds.map(id => Number(id));
            const placeholders = numericIds.map(() => '?').join(', ');

            await sequelize.query(
                `DELETE FROM channel_links
                 WHERE server_id = ?
                   AND (channel_id IN (${placeholders}) OR link_id IN (${placeholders}))`,
                { replacements: [Number(serverId), ...numericIds, ...numericIds], transaction }
            );

            await sequelize.query(
                `DELETE FROM group_members
                 WHERE server_id = ?
                   AND group_id IN (
                       SELECT group_id
                       FROM "groups"
                       WHERE server_id = ?
                         AND channel_id IN (${placeholders})
                   )`,
                { replacements: [Number(serverId), Number(serverId), ...numericIds], transaction }
            );

            await sequelize.query(
                `DELETE FROM acl
                 WHERE server_id = ?
                   AND channel_id IN (${placeholders})`,
                { replacements: [Number(serverId), ...numericIds], transaction }
            );

            await sequelize.query(
                `DELETE FROM channel_info
                 WHERE server_id = ?
                   AND channel_id IN (${placeholders})`,
                { replacements: [Number(serverId), ...numericIds], transaction }
            );

            await sequelize.query(
                `DELETE FROM "groups"
                 WHERE server_id = ?
                   AND channel_id IN (${placeholders})`,
                { replacements: [Number(serverId), ...numericIds], transaction }
            );

            await sequelize.query(
                `DELETE FROM channels
                 WHERE server_id = ?
                   AND channel_id IN (${placeholders})`,
                { replacements: [Number(serverId), ...numericIds], transaction }
            );
        });

        const refreshedChannels = await getChannels(serverId);
        await loadChannelLinks(serverId, refreshedChannels);
        for (const key of Object.keys(channels)) {
            delete channels[key];
        }
        Object.assign(channels, refreshedChannels);

        const refreshedAclState = await loadAclState(serverId);
        refreshAclState(refreshedAclState);

        for (const { id, item } of movedUsers) {
            const targetChannel = findChannelRemovalTarget(channel, item);
            const updatedUser = await Users.updateUser(id, {
                channelId: Number(targetChannel.channel_id)
            });

            Users.emit('broadcast', 'UserState', updatedUser);
        }

        for (const removedId of removedIds) {
            Users.emit('broadcast', 'ChannelRemove', {
                channelId: Number(removedId)
            });
        }

        return { removedIds };
    }

    return {
        canEditAcl,
        syncChannelLinks,
        setChannelInfoValue,
        persistChannelStateChange,
        isChannelDescendantOf,
        collectChannelSubtree,
        findChannelRemovalTarget,
        persistChannelRemoval
    };
}
