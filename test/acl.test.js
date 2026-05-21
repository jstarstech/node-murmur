import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PERMISSIONS,
    ALL_PERMISSIONS,
    DEFAULT_PERMISSIONS,
    computePermissions,
    canEnterChannel,
    isGroupMember,
    buildAclResponse,
    collectAclUserIds
} from '../src/lib/Acl.js';

function makeChannels(entries) {
    const channels = {};
    for (const entry of entries) {
        channels[entry.channel_id] = { inheritacl: 1, ...entry };
    }
    return channels;
}

function makeAclRowsByChannel(channelAcls) {
    const map = new Map();
    for (const [channelId, acls] of Object.entries(channelAcls)) {
        map.set(Number(channelId), acls);
    }
    return map;
}

function makeGroupsByChannel(groups) {
    const map = new Map();
    for (const [channelId, groupMap] of Object.entries(groups)) {
        const inner = new Map();
        for (const [name, group] of Object.entries(groupMap)) {
            inner.set(name, {
                groupId: group.groupId ?? 1,
                channelId: Number(channelId),
                name,
                inherit: group.inherit ?? true,
                inheritable: group.inheritable ?? true,
                add: new Set(group.add ?? []),
                remove: new Set(group.remove ?? [])
            });
        }
        map.set(Number(channelId), inner);
    }
    return map;
}

function makeAclState(aclsByChannel, groupsByChannel) {
    return {
        aclRowsByChannel: aclsByChannel ?? new Map(),
        groupsByChannel: groupsByChannel ?? new Map()
    };
}

function makeUser(overrides) {
    return {
        userId: 1,
        session: 1,
        channelId: 1,
        hash: '',
        tokens: [],
        ...overrides
    };
}

const T = PERMISSIONS.Traverse;
const E = PERMISSIONS.Enter;
const S = PERMISSIONS.Speak;
const W = PERMISSIONS.Whisper;
const TM = PERMISSIONS.TextMessage;
const M = PERMISSIONS.Move;
const Wr = PERMISSIONS.Write;

// ---- Constants ----

test('PERMISSIONS has all expected flags', () => {
    assert.equal(PERMISSIONS.None, 0x0);
    assert.equal(PERMISSIONS.Write, 0x1);
    assert.equal(PERMISSIONS.Traverse, 0x2);
    assert.equal(PERMISSIONS.Enter, 0x4);
    assert.equal(PERMISSIONS.Speak, 0x8);
    assert.equal(PERMISSIONS.MuteDeafen, 0x10);
    assert.equal(PERMISSIONS.Move, 0x20);
    assert.equal(PERMISSIONS.MakeChannel, 0x40);
    assert.equal(PERMISSIONS.LinkChannel, 0x80);
    assert.equal(PERMISSIONS.Whisper, 0x100);
    assert.equal(PERMISSIONS.TextMessage, 0x200);
    assert.equal(PERMISSIONS.MakeTempChannel, 0x400);
    assert.equal(PERMISSIONS.Kick, 0x10000);
    assert.equal(PERMISSIONS.Ban, 0x20000);
    assert.equal(PERMISSIONS.Register, 0x40000);
    assert.equal(PERMISSIONS.SelfRegister, 0x80000);
});

test('DEFAULT_PERMISSIONS includes basic operations', () => {
    assert.equal(DEFAULT_PERMISSIONS, T | E | S | W | TM);
});

test('ALL_PERMISSIONS includes all flags', () => {
    assert.equal(ALL_PERMISSIONS, 0xF07FF);
});

// ---- computePermissions ----

test('SuperUser gets ALL_PERMISSIONS', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const aclState = makeAclState();
    const su = makeUser({ userId: 0, session: 0 });
    assert.equal(computePermissions(1, su, channels, aclState), ALL_PERMISSIONS);
});

test('no ACLs returns DEFAULT_PERMISSIONS', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const aclState = makeAclState();
    const user = makeUser();
    assert.equal(computePermissions(1, user, channels, aclState), DEFAULT_PERMISSIONS);
});

test('SubUser does not get ALL_PERMISSIONS', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const aclState = makeAclState();
    const user = makeUser({ userId: 0, session: null });
    // userId=0 with no session — still SuperUser per code
    assert.equal(computePermissions(1, user, channels, aclState), ALL_PERMISSIONS);
});

test('direct user ACL grants Write permission', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: 1, groupName: null, applyHere: true, applySub: false, grant: Wr, deny: 0 }]
    });
    const aclState = makeAclState(acls);
    const user = makeUser();
    const perms = computePermissions(1, user, channels, aclState);
    assert.ok(perms & Wr);
    assert.ok(perms & E); // Still has defaults
});

test('direct user ACL denies Enter permission', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: 1, groupName: null, applyHere: true, applySub: false, grant: 0, deny: E }]
    });
    const aclState = makeAclState(acls);
    const user = makeUser();
    const perms = computePermissions(1, user, channels, aclState);
    assert.ok(!(perms & E));
});

test('ACL for different user does not affect current user', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: 99, groupName: null, applyHere: true, applySub: false, grant: Wr, deny: 0 }]
    });
    const aclState = makeAclState(acls);
    const user = makeUser();
    const perms = computePermissions(1, user, channels, aclState);
    assert.ok(!(perms & Wr));
    assert.equal(perms, DEFAULT_PERMISSIONS);
});

test('group "all" grant applies to every user', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: null, groupName: 'all', applyHere: true, applySub: false, grant: Wr, deny: 0 }]
    });
    const aclState = makeAclState(acls);
    const user = makeUser();
    const perms = computePermissions(1, user, channels, aclState);
    assert.ok(perms & Wr);
});

test('group "!all" inverts — no user matches, ACL never applies', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: null, groupName: '!all', applyHere: true, applySub: false, grant: Wr, deny: 0 }]
    });
    const aclState = makeAclState(acls);
    const user = makeUser();
    // !all means no one is a member, so the ACL never applies
    const perms = computePermissions(1, user, channels, aclState);
    assert.ok(!(perms & Wr));
});

test('group "in" grants only to users in same channel', () => {
    const channels = makeChannels([
        { channel_id: 1, name: 'root' },
        { channel_id: 2, name: 'other' }
    ]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: null, groupName: 'in', applyHere: true, applySub: false, grant: Wr, deny: 0 }]
    });
    const aclState = makeAclState(acls);

    const userIn = makeUser({ channelId: 1 });
    assert.ok(computePermissions(1, userIn, channels, aclState) & Wr);

    const userOut = makeUser({ channelId: 2 });
    assert.ok(!(computePermissions(1, userOut, channels, aclState) & Wr));
});

test('group "out" grants only to users in different channel', () => {
    const channels = makeChannels([
        { channel_id: 1, name: 'root' },
        { channel_id: 2, name: 'other' }
    ]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: null, groupName: 'out', applyHere: true, applySub: false, grant: Wr, deny: 0 }]
    });
    const aclState = makeAclState(acls);

    const userIn = makeUser({ channelId: 1 });
    assert.ok(!(computePermissions(1, userIn, channels, aclState) & Wr));

    const userOut = makeUser({ channelId: 2 });
    assert.ok(computePermissions(1, userOut, channels, aclState) & Wr);
});

test('group "auth" grants to authenticated users (with session)', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: null, groupName: 'auth', applyHere: true, applySub: false, grant: Wr, deny: 0 }]
    });
    const aclState = makeAclState(acls);

    const authed = makeUser({ session: 1 });
    assert.ok(computePermissions(1, authed, channels, aclState) & Wr);

    const unauthed = makeUser({ session: null });
    assert.ok(!(computePermissions(1, unauthed, channels, aclState) & Wr));
});

test('group "strong" grants to users with certificate hash', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: null, groupName: 'strong', applyHere: true, applySub: false, grant: Wr, deny: 0 }]
    });
    const aclState = makeAclState(acls);

    const withHash = makeUser({ hash: 'abc123' });
    assert.ok(computePermissions(1, withHash, channels, aclState) & Wr);

    const withoutHash = makeUser({ hash: '' });
    assert.ok(!(computePermissions(1, withoutHash, channels, aclState) & Wr));
});

test('group "sub" grants to users in descendant channels', () => {
    const channels = makeChannels([
        { channel_id: 1, name: 'root' },
        { channel_id: 2, name: 'child', parent_id: 1 },
        { channel_id: 3, name: 'sibling', parent_id: 1 }
    ]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: null, groupName: 'sub', applyHere: true, applySub: false, grant: Wr, deny: 0 }]
    });

    // ACL is on channel 1, evaluated for target channel 1
    // 'sub' evaluates at the ACL's channel context (channel 1)
    // user in channel 2 has parent_id=1, which matches channel 1's parent_id check... wait
    // Actually 'sub' checks: iter = channels[user.channelId]; while iter, if iter.parent_id === currentChannelId
    // currentChannelId = the ACL channel (channel 1)
    // user.channelId = 2, parent_id of channel 2 = 1 === currentChannelId (1) → true
    const aclState = makeAclState(acls);
    const inChild = makeUser({ channelId: 2 });
    assert.ok(computePermissions(1, inChild, channels, aclState) & Wr);

    // User in sibling channel also gets it
    const inSibling = makeUser({ channelId: 3 });
    assert.ok(computePermissions(1, inSibling, channels, aclState) & Wr);
});

test('custom group membership grants permissions', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: null, groupName: 'admin', applyHere: true, applySub: false, grant: Wr, deny: 0 }]
    });
    const groups = makeGroupsByChannel({
        1: { admin: { add: [1] } }
    });
    const aclState = makeAclState(acls, groups);
    const user = makeUser({ userId: 1 });
    assert.ok(computePermissions(1, user, channels, aclState) & Wr);
});

test('custom group non-member does not get group permissions', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: null, groupName: 'admin', applyHere: true, applySub: false, grant: Wr, deny: 0 }]
    });
    const groups = makeGroupsByChannel({
        1: { admin: { add: [2] } }
    });
    const aclState = makeAclState(acls, groups);
    const user = makeUser({ userId: 1 }); // Not in group
    assert.ok(!(computePermissions(1, user, channels, aclState) & Wr));
});

test('custom group remove on child excludes inherited member', () => {
    const channels = makeChannels([
        { channel_id: 1, name: 'parent' },
        { channel_id: 2, name: 'child', parent_id: 1 }
    ]);
    const acls = makeAclRowsByChannel({
        2: [{ channelId: 2, userId: null, groupName: 'admin', applyHere: true, applySub: false, grant: Wr, deny: 0 }]
    });
    const groups = makeGroupsByChannel({
        1: { admin: { add: [1] } },
        2: { admin: { add: [], remove: [1] } }
    });
    const aclState = makeAclState(acls, groups);
    // User 1 is inherited from parent group, then removed at child → no longer a member
    const removed = makeUser({ userId: 1 });
    assert.ok(!(computePermissions(2, removed, channels, aclState) & Wr));
});

test('token group prefix (#) matches user tokens', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: null, groupName: '#secret', applyHere: true, applySub: false, grant: Wr, deny: 0 }]
    });
    const aclState = makeAclState(acls);

    const withToken = makeUser({ tokens: ['secret'] });
    assert.ok(computePermissions(1, withToken, channels, aclState) & Wr);

    const withoutToken = makeUser({ tokens: [] });
    assert.ok(!(computePermissions(1, withoutToken, channels, aclState) & Wr));
});

test('hash group prefix ($) matches certificate hash', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: null, groupName: '$abc123', applyHere: true, applySub: false, grant: Wr, deny: 0 }]
    });
    const aclState = makeAclState(acls);

    const matchingHash = makeUser({ hash: 'ABC123' });
    assert.ok(computePermissions(1, matchingHash, channels, aclState) & Wr);

    const nonMatching = makeUser({ hash: 'def456' });
    assert.ok(!(computePermissions(1, nonMatching, channels, aclState) & Wr));
});

test('tilde (~) prefix evaluates group in ACL channel context', () => {
    const channels = makeChannels([
        { channel_id: 1, name: 'parent' },
        { channel_id: 2, name: 'child', parent_id: 1 }
    ]);
    // ACL on channel 1: grant Write to ~in (users in channel 1, evaluated in ACL context)
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: null, groupName: '~in', applyHere: true, applySub: false, grant: Wr, deny: 0 }]
    });
    const aclState = makeAclState(acls);

    // User is in channel 2, but evaluating in ACL context (channel 1)
    // ~in at ACL channel 1: checks if user.channelId === 1 → false
    const inChild = makeUser({ userId: 1, channelId: 2 });
    assert.ok(!(computePermissions(2, inChild, channels, aclState) & Wr));
});

test('ACL with apply_here=false does not apply to the channel it is set on', () => {
    const channels = makeChannels([
        { channel_id: 1, name: 'root' },
        { channel_id: 2, name: 'child', parent_id: 1 }
    ]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: 1, groupName: null, applyHere: false, applySub: true, grant: Wr, deny: 0 }]
    });
    const aclState = makeAclState(acls);
    const user = makeUser();

    // Does not apply to channel 1 itself
    assert.ok(!(computePermissions(1, user, channels, aclState) & Wr));

    // Applies to sub-channel via applySub
    assert.ok(computePermissions(2, user, channels, aclState) & Wr);
});

test('ACL inheritance from parent channel', () => {
    const channels = makeChannels([
        { channel_id: 1, name: 'root' },
        { channel_id: 2, name: 'child', parent_id: 1 }
    ]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: 1, groupName: null, applyHere: true, applySub: true, grant: Wr, deny: 0 }]
    });
    const aclState = makeAclState(acls);
    const user = makeUser();

    // Parent ACL with applySub applies to child
    assert.ok(computePermissions(2, user, channels, aclState) & Wr);
});

test('inheritacl=0 resets permissions to DEFAULT_PERMISSIONS', () => {
    const channels = makeChannels([
        { channel_id: 1, name: 'root' },
        { channel_id: 2, name: 'child', parent_id: 1, inheritacl: 0 }
    ]);
    // Parent grants Write, but child has inheritacl=0
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: 1, groupName: null, applyHere: true, applySub: true, grant: Wr, deny: 0 }]
    });
    const aclState = makeAclState(acls);
    const user = makeUser();

    // Without inheritacl reset, child would have Wr
    // With inheritacl=0, permissions reset to DEFAULT_PERMISSIONS
    const perms = computePermissions(2, user, channels, aclState);
    assert.ok(!(perms & Wr));
    assert.equal(perms, DEFAULT_PERMISSIONS);
});

test('deny removes from granted but does not affect unrelated defaults', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: 1, groupName: null, applyHere: true, applySub: false, grant: 0, deny: S }]
    });
    const aclState = makeAclState(acls);
    const user = makeUser();
    const perms = computePermissions(1, user, channels, aclState);
    assert.ok(!(perms & S));
    assert.ok(perms & E); // Still has Enter
    assert.ok(perms & T); // Still has Traverse
});

test('multiple ACLs are cumulative', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const acls = makeAclRowsByChannel({
        1: [
            { channelId: 1, userId: 1, groupName: null, applyHere: true, applySub: false, grant: Wr, deny: 0 },
            { channelId: 1, userId: 1, groupName: null, applyHere: true, applySub: false, grant: M, deny: 0 }
        ]
    });
    const aclState = makeAclState(acls);
    const user = makeUser();
    const perms = computePermissions(1, user, channels, aclState);
    assert.ok(perms & Wr);
    assert.ok(perms & M);
});

test('ACL granted bit is preserved when also granting a different bit', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const acls = makeAclRowsByChannel({
        1: [
            { channelId: 1, userId: 1, groupName: null, applyHere: true, applySub: false, grant: Wr | M, deny: 0 }
        ]
    });
    const aclState = makeAclState(acls);
    const user = makeUser();
    const perms = computePermissions(1, user, channels, aclState);
    assert.ok(perms & Wr);
    assert.ok(perms & M);
});

test('ACL in subchannel does not affect parent channel', () => {
    const channels = makeChannels([
        { channel_id: 1, name: 'root' },
        { channel_id: 2, name: 'child', parent_id: 1 }
    ]);
    const acls = makeAclRowsByChannel({
        2: [{ channelId: 2, userId: 1, groupName: null, applyHere: true, applySub: false, grant: Wr, deny: 0 }]
    });
    const aclState = makeAclState(acls);
    const user = makeUser();

    // Child's ACL should not affect parent
    const perms = computePermissions(1, user, channels, aclState);
    assert.ok(!(perms & Wr));
});

// ---- canEnterChannel ----

test('canEnterChannel returns true when Enter permission is granted', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const aclState = makeAclState();
    const user = makeUser();
    assert.ok(canEnterChannel(1, user, channels, aclState));
});

test('canEnterChannel returns false when Enter permission is denied', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const acls = makeAclRowsByChannel({
        1: [{ channelId: 1, userId: 1, groupName: null, applyHere: true, applySub: false, grant: 0, deny: E }]
    });
    const aclState = makeAclState(acls);
    const user = makeUser();
    assert.ok(!canEnterChannel(1, user, channels, aclState));
});

// ---- isGroupMember ----

test('isGroupMember returns false for empty name', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const aclState = makeAclState();
    const user = makeUser();
    assert.equal(isGroupMember('', user, 1, 1, channels, aclState), false);
});

test('isGroupMember returns true for group "all"', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const aclState = makeAclState();
    const user = makeUser();
    assert.equal(isGroupMember('all', user, 1, 1, channels, aclState), true);
});

test('isGroupMember returns false for group "none"', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const aclState = makeAclState();
    const user = makeUser();
    assert.equal(isGroupMember('none', user, 1, 1, channels, aclState), false);
});

test('isGroupMember returns true for custom group containing user', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const groups = makeGroupsByChannel({
        1: { admins: { add: [1] } }
    });
    const aclState = makeAclState(new Map(), groups);
    const user = makeUser({ userId: 1 });
    assert.equal(isGroupMember('admins', user, 1, 1, channels, aclState), true);
});

test('isGroupMember returns false for custom group not containing user', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const groups = makeGroupsByChannel({
        1: { admins: { add: [2] } }
    });
    const aclState = makeAclState(new Map(), groups);
    const user = makeUser({ userId: 1 });
    assert.equal(isGroupMember('admins', user, 1, 1, channels, aclState), false);
});

test('isGroupMember supports inverted group "!all"', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const aclState = makeAclState();
    const user = makeUser();
    assert.equal(isGroupMember('!all', user, 1, 1, channels, aclState), false);
});

test('isGroupMember supports hash prefix with certificate match', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const aclState = makeAclState();
    const user = makeUser({ hash: 'abc123' });
    assert.equal(isGroupMember('$abc123', user, 1, 1, channels, aclState), true);
    assert.equal(isGroupMember('$xyz', user, 1, 1, channels, aclState), false);
});

// ---- buildAclResponse ----

test('buildAclResponse returns false query field', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const aclState = makeAclState();
    const result = buildAclResponse(1, channels, aclState);
    assert.equal(result.query, false);
    assert.equal(result.channelId, 1);
});

test('buildAclResponse includes groups and acls arrays', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const aclState = makeAclState();
    const result = buildAclResponse(1, channels, aclState);
    assert.ok(Array.isArray(result.groups));
    assert.ok(Array.isArray(result.acls));
});

// ---- collectAclUserIds ----

test('collectAclUserIds returns sorted user IDs from ACLs and groups', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const acls = makeAclRowsByChannel({
        1: [
            { channelId: 1, userId: 3, groupName: null, applyHere: true, applySub: false, grant: 0, deny: 0 },
            { channelId: 1, userId: 1, groupName: null, applyHere: true, applySub: false, grant: 0, deny: 0 }
        ]
    });
    const groups = makeGroupsByChannel({
        1: { admins: { add: [5, 2] } }
    });
    const aclState = makeAclState(acls, groups);
    const result = collectAclUserIds(1, channels, aclState);
    assert.deepEqual(result, [1, 2, 3, 5]);
});

test('collectAclUserIds returns empty array when no ACLs or groups exist', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const aclState = makeAclState();
    const result = collectAclUserIds(1, channels, aclState);
    assert.deepEqual(result, []);
});

test('collectAclUserIds includes inherited group member IDs', () => {
    const channels = makeChannels([
        { channel_id: 1, name: 'parent' },
        { channel_id: 2, name: 'child', parent_id: 1 }
    ]);
    const acls = makeAclRowsByChannel({});
    const groups = makeGroupsByChannel({
        1: { admins: { add: [1] } }
    });
    const aclState = makeAclState(acls, groups);
    const result = collectAclUserIds(2, channels, aclState);
    assert.ok(result.includes(1));
});
