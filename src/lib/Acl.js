import { Transaction } from 'sequelize';
import { sequelize } from '../models/index.js';

export const PERMISSIONS = Object.freeze({
    None: 0x0,
    Write: 0x1,
    Traverse: 0x2,
    Enter: 0x4,
    Speak: 0x8,
    MuteDeafen: 0x10,
    Move: 0x20,
    MakeChannel: 0x40,
    LinkChannel: 0x80,
    Whisper: 0x100,
    TextMessage: 0x200,
    MakeTempChannel: 0x400,
    Kick: 0x10000,
    Ban: 0x20000,
    Register: 0x40000,
    SelfRegister: 0x80000
});

export const ALL_PERMISSIONS = Object.freeze(
    Object.values(PERMISSIONS).reduce((permissions, permission) => permissions | permission, 0)
);

export const DEFAULT_PERMISSIONS =
    PERMISSIONS.Traverse | PERMISSIONS.Enter | PERMISSIONS.Speak | PERMISSIONS.Whisper | PERMISSIONS.TextMessage;

const bool = value => value === 1 || value === true || value === '1' || value === 'true';

const getChannelPath = (channelId, channels) => {
    const path = [];
    let current = channels[channelId];

    while (current) {
        path.unshift(current);

        if (current.parent_id === null || current.parent_id === undefined) {
            break;
        }

        current = channels[current.parent_id];
    }

    return path;
};

const groupMatchesBuiltin = (name, user, currentChannelId, channels) => {
    if (name === 'none') {
        return false;
    }

    if (name === 'all') {
        return true;
    }

    if (name === 'auth') {
        return user.session !== null && user.session !== undefined;
    }

    if (name === 'strong') {
        return typeof user.hash === 'string' && user.hash.length > 0;
    }

    if (name === 'in') {
        return user.channelId === currentChannelId;
    }

    if (name === 'out') {
        return user.channelId !== currentChannelId;
    }

    if (name === 'sub') {
        let iter = channels[user.channelId];
        while (iter) {
            if (iter.parent_id === currentChannelId) {
                return true;
            }
            if (iter.parent_id === null || iter.parent_id === undefined) {
                break;
            }
            iter = channels[iter.parent_id];
        }
        return false;
    }

    return null;
};

const resolveCustomGroupMembers = (groupName, channelId, channels, aclState) => {
    return resolveGroupRecursive(groupName, channelId, channels, aclState).members;
};

const resolveGroupRecursive = (groupName, channelId, channels, aclState) => {
    const groupsForChannel = aclState.groupsByChannel.get(channelId);
    const group = groupsForChannel ? groupsForChannel.get(groupName) : null;

    const parentId = channels[channelId]?.parent_id ?? null;

    let members = new Set();
    let inheritable = true;

    if (parentId !== null && parentId !== undefined) {
        if (!group || group.inherit) {
            const parentRes = resolveGroupRecursive(groupName, parentId, channels, aclState);
            if (parentRes.inheritable) {
                members = parentRes.members;
            }
        }
    }

    if (group) {
        inheritable = group.inheritable;
        for (const uid of group.add) {
            members.add(uid);
        }
        for (const uid of group.remove) {
            members.delete(uid);
        }
    }

    return { members, inheritable };
};

const groupMatches = (rawName, user, aclChannelId, currentChannelId, channels, aclState) => {
    let name = rawName;
    let invert = false;
    let evaluateInAclContext = false;
    let token = false;
    let hash = false;

    while (name.length > 0) {
        if (name.startsWith('!')) {
            invert = true;
            name = name.slice(1);
            continue;
        }

        if (name.startsWith('~')) {
            evaluateInAclContext = true;
            name = name.slice(1);
            continue;
        }

        if (name.startsWith('#')) {
            token = true;
            name = name.slice(1);
            continue;
        }

        if (name.startsWith('$')) {
            hash = true;
            name = name.slice(1);
            continue;
        }

        break;
    }

    const matchChannelId = evaluateInAclContext ? aclChannelId : currentChannelId;

    let ok;
    if (token) {
        ok =
            Array.isArray(user.tokens) &&
            user.tokens.some(tokenValue => tokenValue.toLowerCase() === name.toLowerCase());
    } else if (hash) {
        ok = typeof user.hash === 'string' && user.hash.toLowerCase() === name.toLowerCase();
    } else {
        const builtin = groupMatchesBuiltin(name, user, matchChannelId, channels);
        if (builtin !== null) {
            ok = builtin;
        } else {
            ok = resolveCustomGroupMembers(name, matchChannelId, channels, aclState).has(user.userId);
        }
    }

    return invert ? !ok : ok;
};

const aclApplies = (acl, targetChannelId, aclChannelId) => {
    if (targetChannelId === aclChannelId) {
        return acl.applyHere;
    }

    return acl.applySub;
};

const getAclChain = (channelId, channels) => {
    const chain = [];
    let current = channels[Number(channelId)];

    while (current) {
        chain.unshift(current);

        const parentId = current.parent_id;
        if (parentId === null || parentId === undefined) {
            break;
        }

        if (!bool(current.inheritacl)) {
            break;
        }

        current = channels[Number(parentId)];
    }

    return chain;
};

const getAncestorGroup = (name, chain, aclState) => {
    for (let index = chain.length - 2; index >= 0; index -= 1) {
        const group = aclState.groupsByChannel.get(Number(chain[index].channel_id))?.get(name);
        if (group) {
            return group;
        }
    }

    return null;
};

function collectAclView(channelId, channels, aclState) {
    const currentChannelId = Number(channelId);
    const currentChannel = channels[currentChannelId] || null;
    const chain = getAclChain(currentChannelId, channels);
    const reply = {
        channelId: currentChannelId,
        inheritAcls: currentChannel ? bool(currentChannel.inheritacl) : true,
        groups: [],
        acls: []
    };
    const userIds = new Set();
    const groupNames = new Set();

    for (const channel of chain) {
        const groupsForChannel = aclState.groupsByChannel.get(Number(channel.channel_id));
        if (!groupsForChannel) {
            continue;
        }

        for (const name of groupsForChannel.keys()) {
            groupNames.add(name);
        }
    }

    for (const channel of chain) {
        const aclRows = aclState.aclRowsByChannel.get(Number(channel.channel_id)) || [];

        for (const acl of aclRows) {
            if (channel.channel_id !== currentChannelId && !acl.applySub) {
                continue;
            }

            const isUserRule = acl.userId !== null && acl.userId !== undefined;
            const isGroupRule =
                !isUserRule && acl.groupName !== null && acl.groupName !== undefined && acl.groupName !== '';

            if (!isUserRule && !isGroupRule) {
                // Skip malformed rules that have neither user nor group
                continue;
            }

            reply.acls.push({
                inherited: Number(channel.channel_id) !== currentChannelId,
                applyHere: acl.applyHere,
                applySubs: acl.applySub,
                userId: isUserRule ? Number(acl.userId) : undefined,
                group: isGroupRule ? acl.groupName : undefined,
                grant: acl.grant,
                deny: acl.deny
            });

            if (isUserRule) {
                userIds.add(Number(acl.userId));
            }
        }
    }

    for (const name of [...groupNames].sort()) {
        const localGroup = aclState.groupsByChannel.get(currentChannelId)?.get(name) || null;
        const ancestorGroup = getAncestorGroup(name, chain, aclState);
        const group = localGroup || ancestorGroup;

        if (!group) {
            continue;
        }

        const inheritedMembers = ancestorGroup
            ? [...resolveCustomGroupMembers(name, Number(ancestorGroup.channelId), channels, aclState)]
            : [];
        const add = localGroup ? [...localGroup.add].map(Number).sort((left, right) => left - right) : [];
        const remove = localGroup ? [...localGroup.remove].map(Number).sort((left, right) => left - right) : [];

        for (const uid of add) {
            userIds.add(uid);
        }

        for (const uid of remove) {
            userIds.add(uid);
        }

        for (const uid of inheritedMembers) {
            userIds.add(uid);
        }

        reply.groups.push({
            name,
            inherited: Boolean(!localGroup && ancestorGroup),
            inherit: localGroup ? localGroup.inherit : group.inherit,
            inheritable: localGroup ? localGroup.inheritable : group.inheritable,
            add,
            remove,
            inheritedMembers: inheritedMembers.map(Number).sort((left, right) => left - right)
        });
    }

    return { reply, userIds };
}

function buildAclInsertQueries(serverId, channelId, payload, nextGroupId) {
    const queries = [];
    const serverIdNum = Number(serverId);
    const targetChannelId = Number(channelId);
    const inheritAcls = Boolean(payload?.inheritAcls ?? true);

    queries.push({
        sql: `UPDATE channels
              SET inheritacl = ?
              WHERE server_id = ?
                AND channel_id = ?`,
        replacements: [inheritAcls ? 1 : 0, serverIdNum, targetChannelId]
    });

    queries.push({
        sql: `DELETE FROM group_members
              WHERE server_id = ?
                AND group_id IN (
                    SELECT group_id
                    FROM "groups"
                    WHERE server_id = ?
                      AND channel_id = ?
                )`,
        replacements: [serverIdNum, serverIdNum, targetChannelId]
    });

    queries.push({
        sql: `DELETE FROM acl
              WHERE server_id = ?
                AND channel_id = ?`,
        replacements: [serverIdNum, targetChannelId]
    });

    queries.push({
        sql: `DELETE FROM "groups"
              WHERE server_id = ?
                AND channel_id = ?`,
        replacements: [serverIdNum, targetChannelId]
    });

    let groupId = nextGroupId;
    for (const group of payload.groups || []) {
        const currentGroupId = groupId++;
        queries.push({
            sql: `INSERT INTO "groups" (group_id, server_id, name, channel_id, inherit, inheritable)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            replacements: [
                Number(currentGroupId),
                serverIdNum,
                group.name,
                targetChannelId,
                group.inherit ? 1 : 0,
                group.inheritable ? 1 : 0
            ]
        });

        for (const uid of group.add || []) {
            queries.push({
                sql: `INSERT INTO group_members (group_id, server_id, user_id, addit)
                      VALUES (?, ?, ?, 1)`,
                replacements: [Number(currentGroupId), serverIdNum, Number(uid)]
            });
        }

        for (const uid of group.remove || []) {
            queries.push({
                sql: `INSERT INTO group_members (group_id, server_id, user_id, addit)
                      VALUES (?, ?, ?, 0)`,
                replacements: [Number(currentGroupId), serverIdNum, Number(uid)]
            });
        }
    }

    let priority = 1;
    for (const acl of payload.acls || []) {
        const grant = Number(acl.grant || 0) & ALL_PERMISSIONS;
        const deny = Number(acl.deny || 0) & ALL_PERMISSIONS;

        queries.push({
            sql: `INSERT INTO acl (server_id, channel_id, priority, user_id, group_name, apply_here, apply_sub, grantpriv, revokepriv)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            replacements: [
                serverIdNum,
                targetChannelId,
                priority++,
                acl.userId !== null && acl.userId !== undefined ? Number(acl.userId) : null,
                acl.group !== null && acl.group !== undefined ? acl.group : null,
                acl.applyHere ? 1 : 0,
                acl.applySubs ? 1 : 0,
                grant,
                deny
            ]
        });
    }

    return queries;
}

export async function loadAclState(serverId) {
    const [aclRows] = await sequelize.query(
        `SELECT server_id, channel_id, priority, user_id, group_name, apply_here, apply_sub, grantpriv, revokepriv
         FROM acl
         WHERE server_id = ?
         ORDER BY channel_id, priority`,
        { replacements: [Number(serverId)] }
    );

    const [groupRows] = await sequelize.query(
        `SELECT group_id, server_id, name, channel_id, inherit, inheritable
         FROM "groups"
         WHERE server_id = ?`,
        { replacements: [Number(serverId)] }
    );

    const [groupMemberRows] = await sequelize.query(
        `SELECT group_id, server_id, user_id, addit
         FROM group_members
         WHERE server_id = ?`,
        { replacements: [Number(serverId)] }
    );

    const aclRowsByChannel = new Map();
    for (const row of aclRows) {
        const channelId = Number(row.channel_id);
        const entries = aclRowsByChannel.get(channelId) || [];
        entries.push({
            channelId,
            priority: row.priority,
            userId: row.user_id,
            groupName: row.group_name,
            applyHere: bool(row.apply_here),
            applySub: bool(row.apply_sub),
            grant: Number(row.grantpriv || 0),
            deny: Number(row.revokepriv || 0)
        });
        aclRowsByChannel.set(channelId, entries);
    }

    const groupsByChannel = new Map();
    const groupsById = new Map();

    for (const row of groupRows) {
        const group = {
            groupId: Number(row.group_id),
            channelId: Number(row.channel_id),
            name: row.name,
            inherit: bool(row.inherit),
            inheritable: bool(row.inheritable),
            add: new Set(),
            remove: new Set()
        };

        groupsById.set(group.groupId, group);

        const groupsForChannel = groupsByChannel.get(group.channelId) || new Map();
        groupsForChannel.set(group.name, group);
        groupsByChannel.set(group.channelId, groupsForChannel);
    }

    for (const row of groupMemberRows) {
        const group = groupsById.get(Number(row.group_id));

        if (!group) {
            continue;
        }

        if (bool(row.addit)) {
            group.add.add(Number(row.user_id));
        } else {
            group.remove.add(Number(row.user_id));
        }
    }

    return {
        aclRowsByChannel,
        groupsByChannel
    };
}

export function computePermissions(channelId, user, channels, aclState) {
    if (user?.userId === 0) {
        return ALL_PERMISSIONS & ~PERMISSIONS.Speak & ~PERMISSIONS.Whisper;
    }

    const path = getChannelPath(channelId, channels);
    let granted = DEFAULT_PERMISSIONS;
    let traverse = true;
    let write = false;

    for (const channel of path) {
        if (!bool(channel.inheritacl)) {
            granted = DEFAULT_PERMISSIONS;
        }

        const aclRows = aclState.aclRowsByChannel.get(channel.channel_id) || [];

        for (const acl of aclRows) {
            const matchesUser = acl.userId != null && Number(acl.userId) === Number(user.userId);
            const matchesGroup =
                acl.groupName !== null &&
                acl.groupName !== undefined &&
                groupMatches(acl.groupName, user, channel.channel_id, channelId, channels, aclState);

            if (!matchesUser && !matchesGroup) {
                continue;
            }

            if (acl.grant & PERMISSIONS.Traverse) traverse = true;
            if (acl.deny & PERMISSIONS.Traverse) traverse = false;
            if (acl.grant & PERMISSIONS.Write) write = true;
            if (acl.deny & PERMISSIONS.Write) write = false;

            if (aclApplies(acl, channelId, channel.channel_id)) {
                granted |= acl.grant;
                granted &= ~acl.deny;
            }
        }

        if (!traverse && !write) {
            granted = 0;
            break;
        }
    }

    if (granted & PERMISSIONS.Write) {
        granted |= ALL_PERMISSIONS & ~PERMISSIONS.Speak & ~PERMISSIONS.Whisper;
    }

    return granted;
}

export function canEnterChannel(channelId, user, channels, aclState) {
    return (computePermissions(channelId, user, channels, aclState) & PERMISSIONS.Enter) === PERMISSIONS.Enter;
}

export function isGroupMember(rawName, user, aclChannelId, currentChannelId, channels, aclState) {
    if (typeof rawName !== 'string' || rawName.length === 0) {
        return false;
    }

    return groupMatches(rawName, user, aclChannelId, currentChannelId, channels, aclState);
}

export function buildAclResponse(channelId, channels, aclState) {
    const { reply } = collectAclView(channelId, channels, aclState);
    return {
        ...reply,
        query: false
    };
}

export function collectAclUserIds(channelId, channels, aclState) {
    const { userIds } = collectAclView(channelId, channels, aclState);
    return [...userIds].sort((left, right) => left - right);
}

export async function saveAclState(serverId, channelId, payload) {
    const serverIdNum = Number(serverId);
    const targetChannelId = Number(channelId);

    await sequelize.transaction({ type: Transaction.TYPES.IMMEDIATE }, async transaction => {
        const [maxRows] = await sequelize.query(
            `SELECT COALESCE(MAX(group_id), 0) AS max_group_id
             FROM "groups"
             WHERE server_id = ?`,
            { replacements: [serverIdNum], transaction }
        );

        const nextGroupId = Number(maxRows?.[0]?.max_group_id || 0) + 1;
        const queries = buildAclInsertQueries(serverIdNum, targetChannelId, payload, nextGroupId);

        for (const { sql, replacements } of queries) {
            await sequelize.query(sql, { replacements, transaction });
        }
    });
}
