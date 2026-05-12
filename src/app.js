import dgram from 'dgram';
import crypto from 'crypto';
import tls from 'tls';
import os from 'os';
import _ from 'underscore';
import BufferPack from 'bufferpack';
import * as util from './lib/util.js';
import MumbleConnection from './lib/MumbleConnection.js';
import User from './lib/User.js';
import {
    buildAclResponse,
    canEnterChannel,
    collectAclUserIds,
    computePermissions,
    loadAclState,
    PERMISSIONS,
    saveAclState
} from './lib/Acl.js';
import CryptState from './lib/CryptState.js';
import { getVoiceKind, getVoiceTarget, rebuildVoicePacket } from './lib/voice.js';
import Config from './models/config.js';
import Channels from './models/channels.js';
import ChannelInfo from './models/channel_info.js';
import RegisteredUsers from './models/users.js';
import UserInfo from './models/user_info.js';
import { sequelize } from './models/index.js';
import { ensureDatabaseReady, resolveConfigFileValue } from './lib/bootstrapDatabase.js';
import { createLogger } from './lib/logger.js';

const log = createLogger();

async function getChannels(server_id) {
    const channels = {};

    const dbChannels = await Channels.findAll({
        where: {
            server_id
        }
    }).catch(err => {
        log.error(new Error(err));

        return [];
    });

    for (const dbChannel of dbChannels) {
        channels[dbChannel.channel_id] = dbChannel;

        const channelInfos = await ChannelInfo.findAll({
            where: {
                server_id,
                channel_id: dbChannel.channel_id
            }
        }).catch(err => {
            log.error(new Error(err));

            return [];
        });

        for (const channelInfo of channelInfos) {
            if (channelInfo.key === 0) {
                channels[channelInfo.channel_id].description = channelInfo.value;
            }

            if (channelInfo.key === 1) {
                channels[channelInfo.channel_id].position = channelInfo.value;
            }
        }
    }

    if (!channels[0]) {
        channels[0] = {
            channel_id: 0,
            parent_id: null,
            name: 'Root',
            description: '',
            position: '0',
            links: new Set()
        };
    } else if (!(channels[0].links instanceof Set)) {
        channels[0].links = new Set();
    }

    for (const channel of Object.values(channels)) {
        if (!(channel.links instanceof Set)) {
            channel.links = new Set();
        }
    }

    return channels;
}

async function loadChannelLinks(serverId, channels) {
    const [rows] = await sequelize.query(
        `SELECT channel_id, link_id
         FROM channel_links
         WHERE server_id = ${Number(serverId)}`
    );

    for (const row of rows || []) {
        const channelId = Number(row.channel_id);
        const linkId = Number(row.link_id);
        const channel = channels[channelId];
        const linkedChannel = channels[linkId];

        if (!channel || !linkedChannel) {
            continue;
        }

        if (!(channel.links instanceof Set)) {
            channel.links = new Set();
        }

        if (!(linkedChannel.links instanceof Set)) {
            linkedChannel.links = new Set();
        }

        channel.links.add(linkId);
        linkedChannel.links.add(channelId);
    }
}

function buildChannelStatePayload(channel, clientVersion = 0) {
    const description = channel.description || '';
    const descriptionBuffer = Buffer.from(description);
    const shouldSendHash = descriptionBuffer.length >= 128 && (clientVersion || 0) >= 0x10202;
    const position = Number.isFinite(Number(channel.position)) ? Number(channel.position) : 0;
    const links = Array.isArray(channel.links) ? channel.links : channel.links instanceof Set ? [...channel.links] : [];

    return {
        channelId: channel.channel_id,
        parent: channel.parent_id,
        name: channel.name,
        links: links
            .map(link => Number(link))
            .filter(link => Number.isFinite(link))
            .sort((left, right) => left - right),
        linksAdd: [],
        linksRemove: [],
        temporary: Boolean(channel.temporary),
        position,
        description: shouldSendHash ? '' : description,
        descriptionHash: shouldSendHash ? crypto.createHash('sha1').update(descriptionBuffer).digest() : null
    };
}

function sendChannelState(connection, channel) {
    connection.sendMessage('ChannelState', buildChannelStatePayload(channel, connection.clientVersion));
}

function sendChannelTree(connection, channels, channel) {
    if (!channel) {
        return;
    }

    sendChannelState(connection, channel);

    const children = Object.values(channels)
        .filter(child => child.parent_id === channel.channel_id)
        .sort((left, right) => {
            const leftPos = Number.isFinite(Number(left.position)) ? Number(left.position) : 0;
            const rightPos = Number.isFinite(Number(right.position)) ? Number(right.position) : 0;
            if (leftPos !== rightPos) {
                return leftPos - rightPos;
            }

            return left.channel_id - right.channel_id;
        });

    for (const child of children) {
        sendChannelTree(connection, channels, child);
    }
}

function buildUserStatePayload(user, clientVersion, { includeBlobs = false } = {}) {
    const payload = {
        session: user.session,
        name: user.name,
        channelId: user.channelId
    };

    if (user.userId !== null && user.userId !== undefined) {
        payload.userId = user.userId;
    }

    if (user.hash) {
        payload.hash = user.hash;
    }

    if (user.deaf) {
        payload.deaf = user.deaf;
    }

    if (user.mute) {
        payload.mute = user.mute;
    }

    if (user.recording) {
        payload.recording = user.recording;
    }

    if (user.suppress) {
        payload.suppress = user.suppress;
    }

    if (user.selfMute) {
        payload.selfMute = user.selfMute;
    }

    if (user.selfDeaf) {
        payload.selfDeaf = user.selfDeaf;
    }

    if (user.prioritySpeaker) {
        payload.prioritySpeaker = user.prioritySpeaker;
    }

    if (user.pluginIdentity) {
        payload.pluginIdentity = user.pluginIdentity;
    }

    if (user.pluginContext && user.pluginContext.length > 0) {
        payload.pluginContext = user.pluginContext;
    }

    const supportsBlobs = includeBlobs || (clientVersion || 0) < 0x10203;

    if (user.texture && user.texture.length > 0) {
        if (supportsBlobs) {
            payload.texture = user.texture;
        } else if (user.textureHash && user.textureHash.length > 0) {
            payload.textureHash = user.textureHash;
        }
    }

    if (user.comment) {
        if (supportsBlobs) {
            payload.comment = user.comment;
        } else if (user.commentHash && user.commentHash.length > 0) {
            payload.commentHash = user.commentHash;
        }
    }

    return payload;
}

async function getRegisteredUsers(serverId) {
    return RegisteredUsers.findAll({
        where: {
            server_id: serverId
        },
        order: [['user_id', 'ASC']]
    });
}

async function createRegisteredUser(serverId, user, certificateHash) {
    const [rows] = await sequelize.query(
        `SELECT COALESCE(MAX(user_id), 0) AS max_user_id
         FROM users
         WHERE server_id = ${Number(serverId)}`
    );

    const nextUserId = Number(rows?.[0]?.max_user_id || 0) + 1;

    const existingName = await RegisteredUsers.findOne({
        where: {
            server_id: serverId,
            name: user.name
        }
    });
    if (existingName) {
        throw new Error('Username is already registered');
    }

    const existingCert = await UserInfo.findOne({
        where: {
            server_id: serverId,
            key: 3,
            value: certificateHash
        }
    });
    if (existingCert) {
        throw new Error('Certificate hash is already registered');
    }

    await RegisteredUsers.create({
        server_id: serverId,
        user_id: nextUserId,
        name: user.name,
        pw: null,
        lastchannel: user.channelId ?? 0,
        texture: null,
        last_active: new Date()
    });

    await UserInfo.create({
        server_id: serverId,
        user_id: nextUserId,
        key: 3,
        value: certificateHash
    });

    return nextUserId;
}

async function sendRegisteredUsers(connection, serverId, query = {}) {
    const registeredUsers = await getRegisteredUsers(serverId);
    const requestedIds = Array.isArray(query.ids) ? query.ids.map(id => Number(id)) : [];
    const requestedNames = Array.isArray(query.names) ? query.names.filter(name => typeof name === 'string') : [];
    const hasFilter = requestedIds.length > 0 || requestedNames.length > 0;

    const filteredUsers = registeredUsers.filter(user => {
        if (Number(user.user_id) === 0) {
            return false;
        }

        if (!hasFilter) {
            return true;
        }

        return requestedIds.includes(Number(user.user_id)) || requestedNames.includes(user.name);
    });

    const users = [];
    for (const user of filteredUsers) {
        users.push({
            userId: Number(user.user_id),
            name: user.name,
            lastSeen:
                user.last_active instanceof Date
                    ? user.last_active.toISOString()
                    : user.last_active
                      ? new Date(user.last_active).toISOString()
                      : undefined
        });
    }

    connection.sendMessage('UserList', { users });
}

async function sendQueryUsers(connection, serverId, query = {}) {
    const registeredUsers = await getRegisteredUsers(serverId);
    const requestedIds = Array.isArray(query.ids) ? query.ids.map(id => Number(id)) : [];
    const requestedNames = Array.isArray(query.names) ? query.names.filter(name => typeof name === 'string') : [];
    const hasFilter = requestedIds.length > 0 || requestedNames.length > 0;
    const namesById = new Map();
    const idsByName = new Map();

    for (const user of registeredUsers) {
        const userId = Number(user.user_id);
        namesById.set(userId, user.name);
        if (typeof user.name === 'string') {
            idsByName.set(user.name, userId);
        }
    }

    const ids = [];
    const names = [];
    const seen = new Set();

    const pushUser = (userId, name) => {
        if (seen.has(userId)) {
            return;
        }

        seen.add(userId);
        ids.push(userId);
        names.push(name);
    };

    if (!hasFilter) {
        for (const user of registeredUsers) {
            const userId = Number(user.user_id);
            if (userId === 0) {
                continue;
            }

            pushUser(userId, user.name);
        }
    } else {
        for (const userId of requestedIds) {
            const name = namesById.get(userId);
            if (typeof name !== 'string' || name.length === 0) {
                continue;
            }

            pushUser(userId, name);
        }

        for (const name of requestedNames) {
            const userId = idsByName.get(name);
            if (userId === undefined || userId === null) {
                continue;
            }

            pushUser(userId, name);
        }
    }

    if (ids.length === 0) {
        return;
    }

    connection.sendMessage('QueryUsers', { ids, names });
}

async function getBans(serverId) {
    const [rows] = await sequelize.query(
        `SELECT base, mask, name, hash, reason, start, duration
         FROM bans
         WHERE server_id = ${Number(serverId)}
         ORDER BY start DESC`
    );

    return rows;
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

async function startServer(server_id) {
    const serverConfig = {};

    const dbConfigs = await Config.findAll({
        where: {
            server_id
        }
    }).catch(err => {
        log.error(new Error(err));

        return [];
    });

    for (const dbConfig of dbConfigs) {
        if (/^\d+$/.test(dbConfig.value)) {
            dbConfig.value = parseInt(dbConfig.value);
        }

        if (dbConfig.value === 'true' || dbConfig.value === 'false') {
            dbConfig.value = dbConfig.value === 'true';
        }

        if (dbConfig.key === 'key' || dbConfig.key === 'certificate') {
            serverConfig[dbConfig.key] = resolveConfigFileValue(dbConfig.value);
            continue;
        }

        serverConfig[dbConfig.key] = dbConfig.value;
    }

    if (typeof serverConfig.port === 'undefined') {
        serverConfig.port = 64738;
    }

    const listenHost =
        serverConfig.host || serverConfig.bindhost || serverConfig.bindip || serverConfig.ip || undefined;

    const channels = await getChannels(server_id);
    await loadChannelLinks(server_id, channels);
    const aclState = await loadAclState(server_id);

    const Users = new User(log);
    const connectionsBySession = new Map();
    const udpAddrToConnection = new Map();
    let serverUdp;

    function getUdpAddrKey(rinfo) {
        return `${rinfo.address}:${rinfo.port}`;
    }

    function requestCryptResync(connection) {
        if (!connection?.cryptState) {
            return;
        }

        if (!connection.cryptState.shouldRequestResync()) {
            return;
        }

        if (connection.lastCryptResync && Date.now() / 1000 - connection.lastCryptResync < 5) {
            return;
        }

        connection.lastCryptResync = Math.floor(Date.now() / 1000);
        connection.sendMessage('CryptSetup', {});
    }

    function sendVoicePacket(connection, rawPacket, fallbackRinfo) {
        if (connection?.cryptState && connection.udpaddr) {
            try {
                const encrypted = connection.cryptState.encrypt(rawPacket);
                const { address, port } = connection.udpaddr;
                udpAddrToConnection.set(getUdpAddrKey(connection.udpaddr), connection);
                serverUdp.send(encrypted, port, address, err => {
                    if (err) {
                        log.error(new Error(err));
                    }
                });
                return;
            } catch (err) {
                log.error(new Error(err));
            }
        }

        if (connection && typeof connection.sendMessage === 'function') {
            connection.sendMessage('UDPTunnel', rawPacket);
            return;
        }

        if (fallbackRinfo && serverUdp) {
            serverUdp.send(rawPacket, fallbackRinfo.port, fallbackRinfo.address, err => {
                if (err) {
                    log.error(new Error(err));
                }
            });
        }
    }

    function findUserBySession(session) {
        return Object.values(Users.users).find(user => user && user.session === session);
    }

    function broadcastChannelState(channel) {
        const payload = buildChannelStatePayload(channel, 0);

        for (const connection of connectionsBySession.values()) {
            if (!connection || connection.state !== 'ready') {
                continue;
            }

            connection.sendMessage('ChannelState', buildChannelStatePayload(channel, connection.clientVersion));
        }

        return payload;
    }

    function refreshAclState(nextAclState) {
        aclState.aclRowsByChannel = nextAclState.aclRowsByChannel;
        aclState.groupsByChannel = nextAclState.groupsByChannel;
    }

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

    async function syncChannelLinks(serverId, channelId, nextLinkIds, transaction) {
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
             WHERE server_id = ${serverIdNum}
               AND (channel_id = ${channelIdNum} OR link_id = ${channelIdNum})`,
            { transaction }
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
                 WHERE server_id = ${serverIdNum}
                   AND channel_id = ${minId}
                   AND link_id = ${maxId}`,
                { transaction }
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
                 SELECT ${serverIdNum}, ${minId}, ${maxId}
                 WHERE NOT EXISTS (
                     SELECT 1
                     FROM channel_links
                     WHERE server_id = ${serverIdNum}
                     AND channel_id = ${minId}
                       AND link_id = ${maxId}
                 )`,
                { transaction }
            );
        }
    }

    async function setChannelInfoValue(serverId, channelId, key, value, transaction) {
        await sequelize.query(
            `DELETE FROM channel_info
             WHERE server_id = ${Number(serverId)}
               AND channel_id = ${Number(channelId)}
               AND key = ${Number(key)}`,
            { transaction }
        );

        if (value === null || value === undefined) {
            return;
        }

        await sequelize.query(
            `INSERT INTO channel_info (server_id, channel_id, key, value)
             VALUES (
                ${Number(serverId)},
                ${Number(channelId)},
                ${Number(key)},
                ${sequelize.escape(value)}
             )`,
            { transaction }
        );
    }

    async function persistChannelStateChange(user, userId, m) {
        const hasChannelId =
            Object.prototype.hasOwnProperty.call(m, 'channelId') && m.channelId !== null && m.channelId !== undefined;
        const isCreate = !hasChannelId;
        const requestedChannelId = hasChannelId ? Number(m.channelId) : null;
        const targetName = typeof m.name === 'string' ? m.name : null;
        const targetParentId = Object.prototype.hasOwnProperty.call(m, 'parent') ? Number(m.parent) : null;
        const temporaryProvided = Object.prototype.hasOwnProperty.call(m, 'temporary');
        const isTemporary = temporaryProvided ? Boolean(m.temporary) : false;
        const descriptionProvided = Object.prototype.hasOwnProperty.call(m, 'description');
        const descriptionValue =
            descriptionProvided && typeof m.description === 'string' && m.description.length > 0 ? m.description : null;
        const positionProvided = Object.prototype.hasOwnProperty.call(m, 'position');
        const linksProvided = Array.isArray(m.linksAdd) || Array.isArray(m.linksRemove);
        const currentChannel = isCreate ? null : channels[requestedChannelId];

        if (isCreate) {
            if (targetParentId === null || targetParentId === undefined || !Number.isFinite(targetParentId)) {
                throw new Error('Invalid parent channel');
            }

            if (!targetName || targetName.length === 0) {
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
                     WHERE server_id = ${Number(1)}`,
                    { transaction }
                );
                const nextChannelId = Number(rows?.[0]?.max_channel_id || 0) + 1;

                await sequelize.query(
                    `INSERT INTO channels (server_id, channel_id, parent_id, name, inheritacl, temporary)
                     VALUES (
                        ${Number(1)},
                        ${Number(nextChannelId)},
                        ${Number(targetParentId)},
                        ${sequelize.escape(targetName)},
                        1,
                        ${isTemporary ? 1 : 0}
                     )`,
                    { transaction }
                );

                await setChannelInfoValue(1, nextChannelId, 0, descriptionValue, transaction);
                if (positionProvided) {
                    await setChannelInfoValue(1, nextChannelId, 1, Number(m.position || 0), transaction);
                }

                if (user.userId !== null && user.userId !== undefined) {
                    await sequelize.query(
                        `INSERT INTO "groups" (server_id, name, channel_id, inherit, inheritable)
                         VALUES (1, 'admin', ${Number(nextChannelId)}, 1, 1)`,
                        { transaction }
                    );

                    await sequelize.query(
                        `INSERT INTO group_members (group_id, server_id, user_id, addit)
                         VALUES (
                            (SELECT group_id FROM "groups" WHERE server_id = 1 AND channel_id = ${Number(nextChannelId)} AND name = 'admin' LIMIT 1),
                            1,
                            ${Number(user.userId)},
                            1
                         )`,
                        { transaction }
                    );
                } else if (user.hash) {
                    await sequelize.query(
                        `INSERT INTO acl (server_id, channel_id, priority, user_id, group_name, apply_here, apply_sub, grantpriv, revokepriv)
                         VALUES (1, ${Number(nextChannelId)}, 1, NULL, ${sequelize.escape(`$${user.hash}`)}, 1, 1, ${
                             PERMISSIONS.Write | PERMISSIONS.Traverse
                         }, 0)`,
                        { transaction }
                    );
                }

                if (Array.isArray(m.linksAdd) && m.linksAdd.length > 0) {
                    await syncChannelLinks(1, nextChannelId, m.linksAdd, transaction);
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

            const refreshedChannels = await getChannels(1);
            await loadChannelLinks(1, refreshedChannels);
            Object.keys(channels).forEach(key => {
                delete channels[key];
            });
            Object.assign(channels, refreshedChannels);

            const refreshedAclState = await loadAclState(1);
            refreshAclState(refreshedAclState);

            const refreshedChannel = channels[createdChannel.channel_id];

            if (createdChannel.temporary) {
                const updatedUser = await Users.updateUser(userId, {
                    channelId: createdChannel.channel_id
                });
                Users.emit('broadcast', 'UserState', updatedUser, userId);
            }

            if (refreshedChannel) {
                broadcastChannelState(refreshedChannel);
            }
            return;
        }

        if (!currentChannel) {
            throw new Error('Invalid channel');
        }

        if (currentChannel.channel_id === 0 && targetName !== null && targetName !== currentChannel.name) {
            const error = new Error('Root channel cannot be renamed');
            error.code = 'root_rename';
            throw error;
        }

        if (targetName !== null && targetName.length === 0) {
            throw new Error('Invalid channel name');
        }

        const currentPermissions = computePermissions(requestedChannelId, user, channels, aclState);
        if (
            targetName !== null ||
            descriptionProvided ||
            positionProvided ||
            linksProvided ||
            targetParentId !== null ||
            temporaryProvided
        ) {
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

        const nextParentId = targetParentId !== null ? targetParentId : Number(currentChannel.parent_id);
        const parentChanged = targetParentId !== null && Number(targetParentId) !== Number(currentChannel.parent_id);
        const nextName = targetName !== null ? targetName : currentChannel.name;
        const nextTemporary = temporaryProvided ? Boolean(m.temporary) : Boolean(currentChannel.temporary);

        const parentChannel = channels[nextParentId];
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
                Number(channel.parent_id) === nextParentId &&
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
                 SET parent_id = ${Number(nextParentId)},
                     name = ${sequelize.escape(nextName)},
                     temporary = ${nextTemporary ? 1 : 0}
                 WHERE server_id = ${Number(1)}
                   AND channel_id = ${Number(requestedChannelId)}`,
                { transaction }
            );

            if (descriptionProvided) {
                await setChannelInfoValue(1, requestedChannelId, 0, descriptionValue, transaction);
            }

            if (positionProvided) {
                await setChannelInfoValue(1, requestedChannelId, 1, Number(m.position || 0), transaction);
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
                await syncChannelLinks(1, requestedChannelId, [...currentLinks], transaction);
            }

            return currentChannel;
        });

        const refreshedChannels = await getChannels(1);
        await loadChannelLinks(1, refreshedChannels);
        Object.keys(channels).forEach(key => {
            delete channels[key];
        });
        Object.assign(channels, refreshedChannels);

        const refreshedAclState = await loadAclState(1);
        refreshAclState(refreshedAclState);

        broadcastChannelState(channels[Number(updatedChannel.channel_id)]);
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
            const idList = removedIds.map(id => Number(id)).join(', ');

            await sequelize.query(
                `DELETE FROM channel_links
                 WHERE server_id = ${Number(1)}
                   AND (channel_id IN (${idList}) OR link_id IN (${idList}))`,
                { transaction }
            );

            await sequelize.query(
                `DELETE FROM group_members
                 WHERE server_id = ${Number(1)}
                   AND group_id IN (
                       SELECT group_id
                       FROM "groups"
                       WHERE server_id = ${Number(1)}
                         AND channel_id IN (${idList})
                   )`,
                { transaction }
            );

            await sequelize.query(
                `DELETE FROM acl
                 WHERE server_id = ${Number(1)}
                   AND channel_id IN (${idList})`,
                { transaction }
            );

            await sequelize.query(
                `DELETE FROM channel_info
                 WHERE server_id = ${Number(1)}
                   AND channel_id IN (${idList})`,
                { transaction }
            );

            await sequelize.query(
                `DELETE FROM "groups"
                 WHERE server_id = ${Number(1)}
                   AND channel_id IN (${idList})`,
                { transaction }
            );

            await sequelize.query(
                `DELETE FROM channels
                 WHERE server_id = ${Number(1)}
                   AND channel_id IN (${idList})`,
                { transaction }
            );
        });

        const refreshedChannels = await getChannels(1);
        await loadChannelLinks(1, refreshedChannels);
        Object.keys(channels).forEach(key => {
            delete channels[key];
        });
        Object.assign(channels, refreshedChannels);

        const refreshedAclState = await loadAclState(1);
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

    function broadcastVoicePacket(rawPacket, sourceSession) {
        const sourceChannelId = Users.sessionToChannels[sourceSession];
        if (sourceChannelId === undefined || sourceChannelId === null) {
            return;
        }

        const target = getVoiceTarget(rawPacket);
        const sourceConnection = connectionsBySession.get(sourceSession);

        if (target === 31) {
            if (sourceConnection) {
                sendVoicePacket(sourceConnection, rawPacket);
            }
            return;
        }

        for (const user of Object.values(Users.users)) {
            if (!user || user.session === undefined || user.session === null) {
                continue;
            }

            if (user.session === sourceSession) {
                continue;
            }

            if (user.channelId !== sourceChannelId) {
                continue;
            }

            if (user.selfDeaf === true) {
                continue;
            }

            const targetConnection = connectionsBySession.get(user.session);
            if (!targetConnection) {
                continue;
            }

            sendVoicePacket(targetConnection, rawPacket);
        }
    }

    const options = {
        key: serverConfig.key,
        cert: serverConfig.certificate,
        requestCert: serverConfig.certrequired,
        rejectUnauthorized: false
    };

    const server = tls.createServer(options, socket => {
        socket.setKeepAlive(true, 10000);
        socket.setTimeout(10000);
        socket.setNoDelay(true);

        log.info({ authorized: socket.authorized }, 'TLS client authorized');

        if (!socket.authorized) {
            log.info({ authorizationError: socket.authorizationError }, 'TLS authorization error');
        }

        let uid;
        let auth = false;
        let ready = false;
        const connection = new MumbleConnection(socket, Users);
        connection.clientCryptoModes = [];
        connection.lastCryptResync = 0;
        connection.state = 'connected';

        function broadcastListener(type, message, sender_uid) {
            if (!['authenticated', 'ready'].includes(connection.state)) {
                return;
            }

            if (sender_uid !== undefined) {
                if (type !== 'UserState' && sender_uid === uid) {
                    return;
                }
            }

            if (type === 'TextMessage' && !message.channelId.includes(Users.getUser(uid).channelId)) {
                return;
            }

            if (type === 'UserState') {
                connection.sendMessage(
                    type,
                    buildUserStatePayload(message, connection.clientVersion, { includeBlobs: false })
                );
                return;
            }

            connection.sendMessage(type, message);
        }

        Users.on('broadcast', broadcastListener);

        function broadcastAudio(packet, source_session) {
            broadcastVoicePacket(packet, source_session);
        }

        Users.on('broadcast_audio', broadcastAudio);

        connection.on('error', err => {
            log.error({ err }, 'User disconnected');
        });

        connection.on('disconnect', async () => {
            log.info('User disconnected');

            const user = Users.getUser(uid);
            if (user.session) {
                Users.emit('broadcast', 'UserRemove', { session: user.session }, uid);
                connectionsBySession.delete(user.session);
                if (connection.udpaddr) {
                    udpAddrToConnection.delete(getUdpAddrKey(connection.udpaddr));
                }
                await Users.deleteUser(uid);
            }

            Users.removeListener('broadcast', broadcastListener);
            Users.removeListener('broadcast_audio', broadcastAudio);
        });

        connection.on('version', version => {
            connection.state = 'version-received';
            connection.clientCryptoModes = Array.isArray(version.cryptoModes) ? version.cryptoModes : [];
            connection.clientVersion = version.version || 0;
        });

        connection.on('textMessage', ({ channelId, message }) => {
            if (connection.state !== 'ready') {
                return;
            }

            if (channelId.length === 0) {
                return;
            }

            const ms = {
                actor: Users.getUser(uid).session,
                session: [],
                channelId,
                treeId: [],
                message
            };

            Users.emit('broadcast', 'TextMessage', ms, uid);
        });

        connection.on('permissionQuery', m => {
            if (connection.state !== 'ready') {
                return;
            }

            const requestedChannelId = Number(m.channelId || 0);
            const user = Users.getUser(uid);
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

            const user = Users.getUser(uid);
            const requestedChannelId = Number(m.channelId || 0);

            if (!user || user.session === undefined) {
                return;
            }

            if (!canEditAcl(requestedChannelId, user)) {
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
                sendQueryUsers(connection, 1, { ids: collectAclUserIds(requestedChannelId, channels, aclState) }).catch(
                    err => {
                        log.error({ err }, 'Failed to resolve ACL query users');
                    }
                );
                return;
            }

            saveAclState(1, requestedChannelId, m)
                .then(async () => {
                    const refreshedAclState = await loadAclState(1);
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

        connection.on('queryUsers', async m => {
            if (!['authenticated', 'ready'].includes(connection.state)) {
                return;
            }

            await sendQueryUsers(connection, 1, m);
        });

        connection.on('userList', async m => {
            if (!['authenticated', 'ready'].includes(connection.state)) {
                return;
            }

            if (!Array.isArray(m.users) || m.users.length === 0) {
                await sendRegisteredUsers(connection, 1, m);
                return;
            }

            for (const entry of m.users) {
                const userId = Number(entry.userId || 0);
                if (userId === 0) {
                    continue;
                }

                if (entry.name === undefined || entry.name === null) {
                    await RegisteredUsers.destroy({
                        where: {
                            server_id: 1,
                            user_id: userId
                        }
                    });

                    await UserInfo.destroy({
                        where: {
                            server_id: 1,
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
                            server_id: 1,
                            user_id: userId
                        }
                    }
                );
            }

            await sendRegisteredUsers(connection, 1, {});
        });

        connection.on('banList', async m => {
            if (!['authenticated', 'ready'].includes(connection.state)) {
                return;
            }

            const user = Users.getUser(uid);
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
                const bans = await getBans(1);
                sendBanList(connection, bans);
                return;
            }

            await sequelize.query(`DELETE FROM bans WHERE server_id = ${Number(1)}`);

            if (Array.isArray(m.bans) && m.bans.length > 0) {
                for (const entry of m.bans) {
                    await sequelize.query(
                        `INSERT INTO bans (server_id, base, mask, name, hash, reason, start, duration)
                         VALUES (
                            ${Number(1)},
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

        connection.on('requestBlob', m => {
            if (!['authenticated', 'ready'].includes(connection.state)) {
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
                if (!target || !target.comment) {
                    continue;
                }

                connection.sendMessage('UserState', {
                    session: target.session,
                    comment: target.comment
                });
            }

            const requestedDescriptions = Array.isArray(m.channelDescription) ? m.channelDescription : [];
            for (const channelId of requestedDescriptions) {
                const channel = channels[Number(channelId)];
                if (!channel || !channel.description) {
                    continue;
                }

                connection.sendMessage('ChannelState', {
                    channelId: channel.channel_id,
                    description: channel.description
                });
            }
        });

        let authUserState = {};
        connection.on('userState', async m => {
            const user = Users.getUser(uid);

            const updateUserState = {
                session: user.session || null,
                actor: user.session || null
            };

            if (Object.prototype.hasOwnProperty.call(m, 'userId') && m.userId !== null && m.userId !== undefined) {
                if (user.userId !== null && user.userId !== undefined) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: PERMISSIONS.SelfRegister,
                        channelId: 0,
                        session: user.session,
                        reason: 'Already registered'
                    });
                    return;
                }

                if (!user.hash) {
                    connection.sendMessage('PermissionDenied', {
                        type: 7,
                        session: user.session,
                        reason: 'Missing certificate'
                    });
                    return;
                }

                const rootPermissions = computePermissions(0, user, channels, aclState);
                if ((rootPermissions & PERMISSIONS.SelfRegister) !== PERMISSIONS.SelfRegister) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: PERMISSIONS.SelfRegister,
                        channelId: 0,
                        session: user.session,
                        reason: 'Permission denied'
                    });
                    return;
                }

                try {
                    const registeredUserId = await createRegisteredUser(1, user, user.hash);
                    const updatedUser = await Users.updateUser(uid, {
                        userId: registeredUserId
                    });

                    Users.emit('broadcast', 'UserState', updatedUser, uid);
                } catch (err) {
                    log.error(new Error(err));
                    connection.sendMessage('PermissionDenied', {
                        type: 0,
                        session: user.session,
                        reason: 'Unable to register user'
                    });
                }

                return;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'deaf') && m.deaf !== user.deaf) {
                updateUserState.deaf = m.deaf;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'mute') && m.mute !== user.mute) {
                updateUserState.mute = m.mute;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'recording') && m.recording !== user.recording) {
                updateUserState.recording = m.recording;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'suppress') && m.suppress !== user.suppress) {
                updateUserState.suppress = m.suppress;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'selfMute') && m.selfMute !== user.selfMute) {
                updateUserState.selfMute = m.selfMute;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'selfDeaf') && m.selfDeaf !== user.selfDeaf) {
                updateUserState.selfDeaf = m.selfDeaf;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'channelId') && m.channelId !== user.channelId) {
                updateUserState.channelId = m.channelId;
            }

            if (
                Object.prototype.hasOwnProperty.call(m, 'prioritySpeaker') &&
                m.prioritySpeaker !== user.prioritySpeaker
            ) {
                updateUserState.prioritySpeaker = m.prioritySpeaker;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'pluginIdentity') && m.pluginIdentity !== user.pluginIdentity) {
                updateUserState.pluginIdentity = m.pluginIdentity;
            }

            if (Object.prototype.hasOwnProperty.call(m, 'pluginContext') && m.pluginContext !== user.pluginContext) {
                updateUserState.pluginContext = m.pluginContext;
            }

            if (
                auth === true &&
                Object.prototype.hasOwnProperty.call(updateUserState, 'channelId') &&
                updateUserState.channelId !== user.channelId
            ) {
                const requestedChannelId = Number(updateUserState.channelId);
                const destinationChannel = channels[requestedChannelId];

                if (!destinationChannel) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: PERMISSIONS.Enter,
                        channelId: requestedChannelId,
                        session: user.session,
                        reason: 'Unknown channel'
                    });
                    return;
                }

                if (!canEnterChannel(requestedChannelId, user, channels, aclState)) {
                    connection.sendMessage('PermissionDenied', {
                        type: 1,
                        permission: PERMISSIONS.Enter,
                        channelId: requestedChannelId,
                        session: user.session,
                        reason: 'Permission denied'
                    });
                    return;
                }
            }

            if (auth === false) {
                authUserState = updateUserState;
                return;
            }

            if (ready === false) {
                return;
            } else {
                await Users.updateUser(uid, updateUserState);
            }

            Users.emit('broadcast', 'UserState', updateUserState, uid);
        });

        connection.sendMessage('Version', {
            version: util.encodeVersion(1, 2, 4),
            release: `1.2.4-0.1${os.platform()}`,
            os: os.platform(),
            osVersion: os.release(),
            cryptoModes: CryptState.supportedModes()
        });
        connection.state = 'version-sent';

        connection.on('authenticate', async m => {
            connection.state = 'authenticating';
            const peerCertificate = socket.getPeerCertificate();
            const certificateHash =
                peerCertificate && typeof peerCertificate.fingerprint === 'string'
                    ? peerCertificate.fingerprint.replace(/:/g, '').toLowerCase()
                    : null;

            const authResult = await Users.addUser({
                name: m.username,
                password: m.password,
                opus: m.opus,
                hash: certificateHash,
                channelId: serverConfig.defaultchannel
            });

            if (authResult.reject) {
                connection.sendMessage('Reject', authResult.reject);
                connection.disconnect();
                return;
            }

            uid = authResult.id;
            connection.state = 'authenticated';

            delete authUserState.channelId;
            await Users.updateUser(uid, authUserState);
            auth = true;

            connection.sessionId = Users.getUser(uid).session;
            connectionsBySession.set(connection.sessionId, connection);

            const negotiatedMode =
                connection.clientCryptoModes.find(mode => CryptState.supportedModes().includes(mode)) ||
                CryptState.supportedModes()[0];
            connection.cryptState = new CryptState(negotiatedMode);
            connection.cryptState.generateKey(negotiatedMode);

            connection.sendMessage('CryptSetup', connection.cryptState.getCryptSetup());

            const rootChannel = channels[0];
            sendChannelTree(connection, channels, rootChannel);

            Users.emit('broadcast', 'UserState', Users.getUser(uid), uid);

            _.each(Users.users, item => {
                if (item.session === connection.sessionId) {
                    return;
                }

                const targetConnection = connectionsBySession.get(item.session);
                if (!targetConnection || targetConnection.state !== 'ready') {
                    return;
                }

                connection.sendMessage(
                    'UserState',
                    buildUserStatePayload(item, targetConnection.clientVersion, { includeBlobs: false })
                );
            });

            connection.sendMessage('ServerSync', {
                session: Users.getUser(uid).session,
                maxBandwidth: serverConfig.bandwidth,
                welcomeText: serverConfig.welcometext,
                permissions: computePermissions(0, Users.getUser(uid), channels, aclState)
            });

            connection.sendMessage('ServerConfig', {
                maxBandwidth: null,
                welcomeText: null,
                allowHtml: true,
                messageLength: serverConfig.textmessagelength,
                imageMessageLength: 1131072
            });

            ready = true;
            connection.state = 'ready';
        });

        connection.on('channelRemove', async ({ channelId }) => {
            if (connection.state !== 'ready') {
                return;
            }

            const user = Users.getUser(uid);
            if (!user || user.session === undefined) {
                return;
            }

            try {
                await persistChannelRemoval(user, channelId);
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

        connection.on('channelState', async m => {
            if (connection.state !== 'ready') {
                return;
            }

            const user = Users.getUser(uid);
            if (!user || user.session === undefined) {
                return;
            }

            try {
                await persistChannelStateChange(user, uid, m);
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

                if (err.code === 'channel_name' || err.code === 'root_rename') {
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

                connection.sendMessage('PermissionDenied', {
                    type: 0,
                    session: user.session,
                    reason: 'Unable to save channel'
                });
            }
        });

        connection.on('ping', m => {
            const { timestamp } = m;
            if (connection.cryptState) {
                connection.cryptState.markRemoteStats(m);
                connection.sendMessage('Ping', connection.cryptState.buildPingResponse(timestamp));
                return;
            }

            connection.sendMessage('Ping', {
                timestamp,
                good: m.good,
                late: m.late,
                lost: m.lost,
                resync: m.resync,
                udpPackets: m.udpPackets,
                tcpPackets: m.tcpPackets,
                udpPingAvg: m.udpPingAvg,
                udpPingVar: m.udpPingVar,
                tcpPingAvg: m.tcpPingAvg,
                tcpPingVar: m.tcpPingVar
            });
        });

        connection.on('cryptSetup', msg => {
            if (!connection.cryptState) {
                return;
            }

            try {
                const response = connection.cryptState.handleCryptSetup(msg);
                if (response) {
                    connection.sendMessage('CryptSetup', response);
                }
            } catch (err) {
                log.error(new Error(err));
            }
        });
    });

    server.listen(serverConfig.port, listenHost, () => {
        const address = server.address();
        log.info(
            {
                serverId: server_id,
                serverName: serverConfig.registername || null,
                protocol: 'tcp',
                address: typeof address === 'object' && address ? address.address : listenHost || '0.0.0.0',
                port: typeof address === 'object' && address ? address.port : serverConfig.port
            },
            'Server started and listening'
        );
    });

    serverUdp = dgram.createSocket('udp4');

    serverUdp.on('listening', () => {
        // const address = serverUdp.address();;
    });

    serverUdp.on('message', (message, rinfo) => {
        if (message.length === 12) {
            const q = BufferPack.unpack('>id', message, 0);

            const buffer = BufferPack.pack('>idiii', [0x00010204, q[1], Object.keys(Users.users).length, 5, 128000]);

            serverUdp.send(buffer, 0, buffer.length, rinfo.port, rinfo.address, err => {
                if (err) {
                    throw err;
                }
            });
            return;
        }

        const addrKey = getUdpAddrKey(rinfo);
        const mappedConnection = udpAddrToConnection.get(addrKey);
        const candidates = [];

        if (mappedConnection) {
            candidates.push({ connection: mappedConnection, requestResync: true });
        }

        for (const connection of connectionsBySession.values()) {
            if (connection === mappedConnection) {
                continue;
            }

            candidates.push({ connection, requestResync: false });
        }

        let matchedConnection = null;
        let plain = null;

        for (const { connection, requestResync } of candidates) {
            if (!connection?.cryptState) {
                continue;
            }

            try {
                plain = connection.cryptState.decrypt(message);
                matchedConnection = connection;
                break;
            } catch {
                if (requestResync) {
                    requestCryptResync(connection);
                }
            }
        }

        if (!matchedConnection || !plain) {
            return;
        }

        matchedConnection.udpaddr = rinfo;
        udpAddrToConnection.set(addrKey, matchedConnection);

        const kind = getVoiceKind(plain);

        if (kind === 1) {
            sendVoicePacket(matchedConnection, plain, rinfo);
            return;
        }

        const voicePacket = rebuildVoicePacket(matchedConnection.sessionId, plain);
        if (!voicePacket) {
            return;
        }

        broadcastVoicePacket(voicePacket, matchedConnection.sessionId);
    });

    serverUdp.bind(serverConfig.port, listenHost, () => {
        const address = serverUdp.address();
        log.info(
            {
                serverId: server_id,
                serverName: serverConfig.registername || null,
                protocol: 'udp',
                address: typeof address === 'object' && address ? address.address : listenHost || '0.0.0.0',
                port: typeof address === 'object' && address ? address.port : serverConfig.port
            },
            'UDP socket started and listening'
        );
    });
}

const bootstrap = await ensureDatabaseReady();

if (bootstrap.superUserPassword) {
    log.info(
        {
            serverId: 1,
            username: 'SuperUser',
            password: bootstrap.superUserPassword
        },
        'Created initial superuser account'
    );
}

startServer(1).catch(e => {
    log.error(e);
    process.exit(1);
});
