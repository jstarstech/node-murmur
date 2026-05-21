import assert from 'node:assert/strict';
import test from 'node:test';
import { collectVoiceTargetChannels, collectVoiceTargetRecipients } from '../src/lib/voiceRouting.js';

function makeChannels(entries) {
    const channels = {};
    for (const entry of entries) {
        channels[entry.channel_id] = entry;
    }
    return channels;
}

function makeUsers(entries) {
    const users = {};
    for (const entry of entries) {
        users[entry.userId] = entry;
    }
    return { users };
}

function makeConnections(sessions) {
    const map = new Map();
    for (const session of sessions) {
        map.set(session, { sendMessage: () => {} });
    }
    return map;
}

function makeAclState() {
    return {
        channelAcls: {},
        channelGroups: {},
        aclRowsByChannel: new Map()
    };
}

test('collectVoiceTargetChannels returns empty set for unknown channel', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'test' }]);
    const result = collectVoiceTargetChannels({ id: 999 }, channels);
    assert.equal(result.size, 0);
});

test('collectVoiceTargetChannels returns channel id without links', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'test' }]);
    const result = collectVoiceTargetChannels({ id: 1, links: false, subChannels: false }, channels);
    assert.equal(result.size, 1);
    assert.ok(result.has(1));
});

test('collectVoiceTargetChannels includes linked channels', () => {
    const channels = makeChannels([
        { channel_id: 1, name: 'a' },
        { channel_id: 2, name: 'b' },
        { channel_id: 3, name: 'c' }
    ]);
    channels[1].links = new Set([2]);
    channels[2].links = new Set([1]);

    const result = collectVoiceTargetChannels({ id: 1, links: true, subChannels: false }, channels);
    assert.ok(result.has(1));
    assert.ok(result.has(2));
    assert.ok(!result.has(3));
});

test('collectVoiceTargetChannels includes subchannels', () => {
    const channels = makeChannels([
        { channel_id: 1, name: 'root' },
        { channel_id: 2, name: 'child', parent_id: 1 },
        { channel_id: 3, name: 'grandchild', parent_id: 2 }
    ]);

    const result = collectVoiceTargetChannels({ id: 1, links: false, subChannels: true }, channels);
    assert.ok(result.has(1));
    assert.ok(result.has(2));
    assert.ok(result.has(3));
});

test('collectVoiceTargetRecipients returns empty recipients for unknown target channel', () => {
    const result = collectVoiceTargetRecipients(
        1,
        { userId: 1 },
        { channels: [{ id: 999 }], sessions: new Set() },
        makeChannels([{ channel_id: 1, name: 'root' }]),
        makeAclState(),
        makeUsers([]),
        makeConnections([])
    );
    assert.equal(result.directRecipients.size, 0);
    assert.equal(result.channelRecipients.size, 0);
});

test('collectVoiceTargetRecipients includes direct session recipients', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const users = makeUsers([
        { userId: 1, session: 100, channelId: 1 },
        { userId: 2, session: 200, channelId: 1 }
    ]);
    const connections = makeConnections([200]);

    const result = collectVoiceTargetRecipients(
        100,
        users.users[1],
        { channels: [], sessions: new Set([200]) },
        channels,
        makeAclState(),
        users,
        connections
    );
    assert.equal(result.directRecipients.size, 1);
    assert.ok(result.directRecipients.has(200));
    assert.equal(result.channelRecipients.size, 0);
});

test('collectVoiceTargetRecipients excludes source session from direct recipients', () => {
    const users = makeUsers([
        { userId: 1, session: 100, channelId: 1 }
    ]);
    const connections = makeConnections([100]);

    const result = collectVoiceTargetRecipients(
        100,
        users.users[1],
        { channels: [], sessions: new Set([100]) },
        {},
        makeAclState(),
        users,
        connections
    );
    assert.equal(result.directRecipients.size, 0);
});

test('collectVoiceTargetRecipients uses SuperUser for channel whisper (userId=0 grants ALL_PERMISSIONS)', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const users = makeUsers([
        { userId: 0, session: 100, channelId: 1 },
        { userId: 2, session: 200, channelId: 1, selfDeaf: true },
        { userId: 3, session: 300, channelId: 1 }
    ]);
    const connections = makeConnections([200, 300]);

    const result = collectVoiceTargetRecipients(
        100,
        users.users[0],
        { channels: [{ id: 1, links: false, subChannels: false, onlyGroup: '' }], sessions: new Set() },
        channels,
        makeAclState(),
        users,
        connections
    );
    assert.ok(!result.channelRecipients.has(200), 'self-deafened user should be excluded');
    assert.ok(result.channelRecipients.has(300), 'non-deafened user should be included');
});

test('collectVoiceTargetRecipients excludes source from channel recipients (SuperUser)', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const users = makeUsers([
        { userId: 0, session: 100, channelId: 1 }
    ]);
    const connections = makeConnections([100]);

    const result = collectVoiceTargetRecipients(
        100,
        users.users[0],
        { channels: [{ id: 1, links: false, subChannels: false, onlyGroup: '' }], sessions: new Set() },
        channels,
        makeAclState(),
        users,
        connections
    );
    assert.ok(!result.channelRecipients.has(100));
});

test('collectVoiceTargetRecipients skips users without connections (SuperUser)', () => {
    const channels = makeChannels([{ channel_id: 1, name: 'root' }]);
    const users = makeUsers([
        { userId: 0, session: 100, channelId: 1 },
        { userId: 2, session: 200, channelId: 1 }
    ]);
    const connections = makeConnections([]);

    const result = collectVoiceTargetRecipients(
        100,
        users.users[0],
        { channels: [{ id: 1, links: false, subChannels: false, onlyGroup: '' }], sessions: new Set() },
        channels,
        makeAclState(),
        users,
        connections
    );
    assert.ok(!result.channelRecipients.has(200));
});

test('collectVoiceTargetRecipients skips users from different channel (SuperUser)', () => {
    const channels = makeChannels([
        { channel_id: 1, name: 'a' },
        { channel_id: 2, name: 'b' }
    ]);
    const users = makeUsers([
        { userId: 0, session: 100, channelId: 1 },
        { userId: 2, session: 200, channelId: 2 }
    ]);
    const connections = makeConnections([200]);

    const result = collectVoiceTargetRecipients(
        100,
        users.users[0],
        { channels: [{ id: 1, links: false, subChannels: false, onlyGroup: '' }], sessions: new Set() },
        channels,
        makeAclState(),
        users,
        connections
    );
    assert.ok(!result.channelRecipients.has(200));
});
