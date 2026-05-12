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

const groupMatchesBuiltin = (name, user, currentChannelId) => {
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
        return false;
    }

    if (name === 'in') {
        return user.channelId === currentChannelId;
    }

    if (name === 'out') {
        return user.channelId !== currentChannelId;
    }

    if (name === 'sub') {
        return false;
    }

    return null;
};

const getGroupDefinition = (groupName, channelId, channels, aclState) => {
    let currentId = channelId;

    while (currentId !== null && currentId !== undefined) {
        const groupsForChannel = aclState.groupsByChannel.get(currentId);
        const group = groupsForChannel ? groupsForChannel.get(groupName) : null;

        if (group) {
            return group;
        }

        currentId = channels[currentId]?.parent_id ?? null;
    }

    return null;
};

const resolveCustomGroupMembers = (groupName, channelId, channels, aclState) => {
    const definition = getGroupDefinition(groupName, channelId, channels, aclState);

    if (!definition) {
        return new Set();
    }

    const definitions = [];
    let currentId = definition.channelId;

    while (currentId !== null && currentId !== undefined) {
        const groupsForChannel = aclState.groupsByChannel.get(currentId);
        const group = groupsForChannel ? groupsForChannel.get(groupName) : null;

        if (!group) {
            break;
        }

        definitions.unshift(group);

        if (!group.inherit) {
            break;
        }

        const parentId = channels[currentId]?.parent_id ?? null;
        if (parentId === null || parentId === undefined) {
            break;
        }

        const parentGroup = aclState.groupsByChannel.get(parentId)?.get(groupName);
        if (!parentGroup || !parentGroup.inheritable) {
            break;
        }

        currentId = parentId;
    }

    const members = new Set();

    for (const group of definitions) {
        for (const uid of group.remove) {
            members.delete(uid);
        }

        for (const uid of group.add) {
            members.add(uid);
        }
    }

    return members;
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
        const builtin = groupMatchesBuiltin(name, user, matchChannelId);
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

export async function loadAclState(serverId) {
    const [aclRows] = await sequelize.query(
        `SELECT server_id, channel_id, priority, user_id, group_name, apply_here, apply_sub, grantpriv, revokepriv
         FROM acl
         WHERE server_id = ${Number(serverId)}
         ORDER BY channel_id, priority`
    );

    const [groupRows] = await sequelize.query(
        `SELECT group_id, server_id, name, channel_id, inherit, inheritable
         FROM "groups"
         WHERE server_id = ${Number(serverId)}`
    );

    const [groupMemberRows] = await sequelize.query(
        `SELECT group_id, server_id, user_id, addit
         FROM group_members
         WHERE server_id = ${Number(serverId)}`
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
        return ALL_PERMISSIONS;
    }

    const path = getChannelPath(channelId, channels);
    let granted = DEFAULT_PERMISSIONS;

    for (const channel of path) {
        if (!bool(channel.inheritacl)) {
            granted = DEFAULT_PERMISSIONS;
        }

        const aclRows = aclState.aclRowsByChannel.get(channel.channel_id) || [];

        for (const acl of aclRows) {
            if (!aclApplies(acl, channelId, channel.channel_id)) {
                continue;
            }

            const matchesUser = acl.userId != null && Number(acl.userId) === Number(user.userId);
            const matchesGroup =
                acl.groupName !== null &&
                acl.groupName !== undefined &&
                groupMatches(acl.groupName, user, channel.channel_id, channelId, channels, aclState);

            if (!matchesUser && !matchesGroup) {
                continue;
            }

            granted |= acl.grant;
            granted &= ~acl.deny;
        }
    }

    return granted;
}

export function canEnterChannel(channelId, user, channels, aclState) {
    return (computePermissions(channelId, user, channels, aclState) & PERMISSIONS.Enter) === PERMISSIONS.Enter;
}

export function buildAclResponse(channelId, channels, aclState) {
    const channel = channels[channelId];
    const aclRows = aclState.aclRowsByChannel.get(channelId) || [];
    const groupsForChannel = aclState.groupsByChannel.get(channelId) || new Map();

    return {
        channelId,
        inheritAcls: channel ? bool(channel.inheritacl) : true,
        groups: [...groupsForChannel.values()].map(group => ({
            name: group.name,
            inherited: false,
            inherit: group.inherit,
            inheritable: group.inheritable,
            add: [...group.add],
            remove: [...group.remove],
            inheritedMembers: []
        })),
        acls: aclRows.map(acl => ({
            applyHere: acl.applyHere,
            applySubs: acl.applySub,
            inherited: false,
            userId: acl.userId,
            group: acl.groupName,
            grant: acl.grant,
            deny: acl.deny
        })),
        query: false
    };
}
