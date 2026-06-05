import { collectPeerCertificates } from './certUtil.js';
import { ipToBuffer } from './ipUtil.js';
import RegisteredUsers from '../models/users.js';
import UserInfo from '../models/user_info.js';
import { sequelize } from '../models/index.js';

const DEFAULT_USERNAME_PATTERN = '[-=\\w\\[\\]\\{\\}\\(\\)@\\|\\.]+';

function buildUserStatePayload(
    user,
    clientVersion,
    { includeBlobs = false, includeActor = true, includeUnsetFlags = true } = {}
) {
    const has = key => Object.prototype.hasOwnProperty.call(user, key);
    const payload = {
        session: user.session,
        name: user.name,
        channelId: user.channelId
    };

    if (includeActor && user.actor !== null && user.actor !== undefined) {
        payload.actor = user.actor;
    }

    if (user.userId !== null && user.userId !== undefined) {
        payload.userId = user.userId;
    }

    if (user.hash) {
        payload.hash = user.hash;
    }

    if (includeUnsetFlags && has('deaf')) {
        payload.deaf = Boolean(user.deaf);
    }

    if ((includeUnsetFlags && has('mute')) || user.mute === true) {
        payload.mute = Boolean(user.mute);
    }

    if ((includeUnsetFlags && has('recording')) || user.recording === true) {
        payload.recording = Boolean(user.recording);
    }

    if ((includeUnsetFlags && has('suppress')) || user.suppress === true) {
        payload.suppress = Boolean(user.suppress);
    }

    if ((includeUnsetFlags && has('selfMute')) || user.selfMute === true) {
        payload.selfMute = Boolean(user.selfMute);
    }

    if ((includeUnsetFlags && has('selfDeaf')) || user.selfDeaf === true) {
        payload.selfDeaf = Boolean(user.selfDeaf);
    }

    if ((includeUnsetFlags && has('prioritySpeaker')) || user.prioritySpeaker === true) {
        payload.prioritySpeaker = Boolean(user.prioritySpeaker);
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

    if (user.comment !== null && user.comment !== undefined) {
        if (user.comment.length === 0) {
            payload.comment = '';
        } else if (supportsBlobs) {
            payload.comment = user.comment;
        } else if (user.commentHash && user.commentHash.length > 0) {
            payload.commentHash = user.commentHash;
        }
    }

    return payload;
}

function buildUserStatsPayload(
    targetUser,
    targetConnection,
    { statsOnly = false, extended = false, local = false } = {}
) {
    const payload = {
        session: targetUser.session,
        statsOnly: Boolean(statsOnly)
    };

    if (extended) {
        const certificates = collectPeerCertificates(targetConnection);
        if (certificates.length > 0) {
            payload.certificates = certificates;
        }

        payload.strongCertificate = Boolean(targetConnection?.socket?.socket?.authorized);
    }

    if (local) {
        const cryptState = targetConnection?.cryptState;
        payload.fromClient = {
            good: Number(cryptState?.good || 0),
            late: Number(cryptState?.late || 0),
            lost: Number(cryptState?.lost || 0),
            resync: Number(cryptState?.resync || 0)
        };

        payload.fromServer = {
            good: Number(cryptState?.remoteGood || 0),
            late: Number(cryptState?.remoteLate || 0),
            lost: Number(cryptState?.remoteLost || 0),
            resync: Number(cryptState?.remoteResync || 0)
        };
    }

    const cryptState = targetConnection?.cryptState;
    payload.udpPackets = Number(cryptState?.remoteUdpPackets || 0);
    payload.tcpPackets = Number(cryptState?.remoteTcpPackets || 0);
    payload.udpPingAvg = Number(cryptState?.remoteUdpPingAvg || 0);
    payload.udpPingVar = Number(cryptState?.remoteUdpPingVar || 0);
    payload.tcpPingAvg = Number(cryptState?.remoteTcpPingAvg || 0);
    payload.tcpPingVar = Number(cryptState?.remoteTcpPingVar || 0);

    if (!statsOnly) {
        payload.version = {
            version: Number(targetConnection?.clientVersion || 0),
            release: targetConnection?.clientRelease || undefined,
            os: targetConnection?.clientOS || undefined,
            osVersion: targetConnection?.clientOSVersion || undefined
        };
        payload.celtVersions = Array.isArray(targetConnection?.clientCeltVersions)
            ? targetConnection.clientCeltVersions.slice()
            : [];
        payload.opus = Boolean(targetConnection?.clientOpus);
        payload.address = ipToBuffer(targetConnection?.socket?.socket?.remoteAddress || '');
    }

    if (targetConnection) {
        const now = Date.now();
        payload.onlinesecs = Math.floor((now - (targetConnection.createdAt || now)) / 1000);
        payload.idlesecs = Math.floor((now - (targetConnection.lastActivityAt || now)) / 1000);
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
         WHERE server_id = ?`,
        { replacements: [Number(serverId)] }
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

async function setUserInfoValue(serverId, userId, key, value, transaction) {
    await sequelize.query(
        `DELETE FROM user_info
         WHERE server_id = ?
           AND user_id = ?
           AND key = ?`,
        { replacements: [Number(serverId), Number(userId), Number(key)], transaction }
    );

    if (value === null || value === undefined) {
        return;
    }

    await sequelize.query(
        `INSERT INTO user_info (server_id, user_id, key, value)
         VALUES (?, ?, ?, ?)`,
        { replacements: [Number(serverId), Number(userId), Number(key), value], transaction }
    );
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

function buildUsernameValidator(pattern, maxLength = 512) {
    const source = typeof pattern === 'string' && pattern.length > 0 ? pattern : DEFAULT_USERNAME_PATTERN;
    const max = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : 0;
    const lengthGuard = max > 0 ? `(?=[\\s\\S]{1,${max}}$)` : '';

    try {
        return new RegExp(`^${lengthGuard}(?:${source})$`);
    } catch {
        return new RegExp(`^${lengthGuard}(?:${DEFAULT_USERNAME_PATTERN})$`);
    }
}

export {
    buildUserStatePayload,
    buildUserStatsPayload,
    getRegisteredUsers,
    createRegisteredUser,
    setUserInfoValue,
    sendRegisteredUsers,
    sendQueryUsers,
    buildUsernameValidator
};
