import assert from 'node:assert/strict';
import test from 'node:test';
import {
    buildChannelStatePayload,
    buildChannelNameValidator,
    collectLinkedChannelIds,
    collectSubchannelIds
} from '../src/lib/channelHelpers.js';

// ---- buildChannelNameValidator ----

test('buildChannelNameValidator returns regex matching default pattern', () => {
    const validate = buildChannelNameValidator();
    assert.ok(validate instanceof RegExp);
    assert.ok(validate.test('general'));
    assert.ok(validate.test('channel-123'));
    assert.ok(validate.test('a_b'));
});

test('buildChannelNameValidator returns regex matching custom pattern', () => {
    const validate = buildChannelNameValidator('[a-z]+');
    assert.ok(validate.test('hello'));
    assert.ok(!validate.test('HELLO'));
});

test('buildChannelNameValidator falls back to default on invalid regex', () => {
    const validate = buildChannelNameValidator('[');
    assert.ok(validate instanceof RegExp);
    assert.ok(validate.test('general'));
});

test('buildChannelNameValidator uses default for empty pattern', () => {
    const validate = buildChannelNameValidator('');
    assert.ok(validate instanceof RegExp);
    assert.ok(validate.test('general'));
});

test('buildChannelNameValidator enforces the configured max length', () => {
    const validate = buildChannelNameValidator(undefined, 8);
    assert.ok(validate.test('general'));
    assert.ok(!validate.test('a'.repeat(9)));
    assert.ok(validate.test('a'.repeat(8)));
});

test('buildChannelNameValidator treats max length 0 as unlimited', () => {
    const validate = buildChannelNameValidator(undefined, 0);
    assert.ok(validate.test('a'.repeat(5000)));
});

// ---- buildChannelStatePayload ----

test('buildChannelStatePayload returns correct shape for minimal channel', () => {
    const channel = { channel_id: 1, parent_id: null, name: 'Root' };
    const result = buildChannelStatePayload(channel);
    assert.equal(result.channelId, 1);
    assert.equal(result.parent, null);
    assert.equal(result.name, 'Root');
    assert.deepEqual(result.links, []);
    assert.equal(result.temporary, false);
    assert.equal(result.description, '');
    assert.equal(result.descriptionHash, null);
});

test('buildChannelStatePayload includes position', () => {
    const channel = { channel_id: 1, parent_id: null, name: 'test', position: '5' };
    const result = buildChannelStatePayload(channel);
    assert.equal(result.position, 5);
});

test('buildChannelStatePayload treats NaN position as 0', () => {
    const channel = { channel_id: 1, parent_id: null, name: 'test', position: 'abc' };
    const result = buildChannelStatePayload(channel);
    assert.equal(result.position, 0);
});

test('buildChannelStatePayload converts links Set to sorted array', () => {
    const channel = { channel_id: 1, parent_id: null, name: 'test', links: new Set([3, 1, 2]) };
    const result = buildChannelStatePayload(channel);
    assert.deepEqual(result.links, [1, 2, 3]);
});

test('buildChannelStatePayload uses links array directly', () => {
    const channel = { channel_id: 1, parent_id: null, name: 'test', links: [3, 1] };
    const result = buildChannelStatePayload(channel);
    assert.deepEqual(result.links, [1, 3]);
});

test('buildChannelStatePayload skips non-numeric link values', () => {
    const channel = { channel_id: 1, parent_id: null, name: 'test', links: [1, 'abc', NaN] };
    const result = buildChannelStatePayload(channel);
    assert.deepEqual(result.links, [1]);
});

test('buildChannelStatePayload returns temporary true when set', () => {
    const channel = { channel_id: 1, parent_id: null, name: 'test', temporary: 1 };
    const result = buildChannelStatePayload(channel);
    assert.equal(result.temporary, true);
});

test('buildChannelStatePayload sends description hash for long descriptions with client >= 1.2.2', () => {
    const longDesc = 'x'.repeat(200);
    const channel = { channel_id: 1, parent_id: null, name: 'test', description: longDesc };
    const result = buildChannelStatePayload(channel, 0x10202);
    assert.equal(result.description, '');
    assert.ok(result.descriptionHash instanceof Buffer);
    assert.equal(result.descriptionHash.length, 20);
});

test('buildChannelStatePayload sends full description for short descriptions', () => {
    const shortDesc = 'short desc';
    const channel = { channel_id: 1, parent_id: null, name: 'test', description: shortDesc };
    const result = buildChannelStatePayload(channel);
    assert.equal(result.description, shortDesc);
    assert.equal(result.descriptionHash, null);
});

test('buildChannelStatePayload sends full description for long desc with includeDescription=true', () => {
    const longDesc = 'x'.repeat(200);
    const channel = { channel_id: 1, parent_id: null, name: 'test', description: longDesc };
    const result = buildChannelStatePayload(channel, 0x10202, { includeDescription: true });
    assert.equal(result.description, longDesc);
    assert.equal(result.descriptionHash, null);
});

test('buildChannelStatePayload uses empty string for missing description', () => {
    const channel = { channel_id: 1, parent_id: null, name: 'test' };
    const result = buildChannelStatePayload(channel);
    assert.equal(result.description, '');
});

test('buildChannelStatePayload uses empty links for missing links field', () => {
    const channel = { channel_id: 1, parent_id: null, name: 'test' };
    const result = buildChannelStatePayload(channel);
    assert.deepEqual(result.links, []);
});

test('buildChannelStatePayload returns descriptionHash null for short descriptions even with client >= 1.2.2', () => {
    const channel = { channel_id: 1, parent_id: null, name: 'test', description: 'short' };
    const result = buildChannelStatePayload(channel, 0x10202);
    assert.equal(result.description, 'short');
    assert.equal(result.descriptionHash, null);
});

// ---- collectLinkedChannelIds ----

test('collectLinkedChannelIds returns empty set for channel with no links', () => {
    const channels = {
        1: { channel_id: 1, links: new Set() }
    };
    const result = collectLinkedChannelIds(1, channels);
    assert.equal(result.size, 0);
});

test('collectLinkedChannelIds returns linked channels (includes source via back-link)', () => {
    const channels = {
        1: { channel_id: 1, links: new Set([2]) },
        2: { channel_id: 2, links: new Set([1]) }
    };
    const result = collectLinkedChannelIds(1, channels);
    // Source channel 1 is included when encountered via a back-link
    assert.ok(result.has(2));
    assert.ok(result.has(1));
    assert.equal(result.size, 2);
});

test('collectLinkedChannelIds traverses transitive links', () => {
    const channels = {
        1: { channel_id: 1, links: new Set([2]) },
        2: { channel_id: 2, links: new Set([1, 3]) },
        3: { channel_id: 3, links: new Set([2]) }
    };
    const result = collectLinkedChannelIds(1, channels);
    assert.ok(result.has(2));
    assert.ok(result.has(3));
    assert.ok(result.has(1)); // Source included via back-link
});

test('collectLinkedChannelIds records missing linked channel ID', () => {
    const channels = {
        1: { channel_id: 1, links: new Set([2]) }
    };
    // Channel 2 doesn't exist in channels object, but ID is still recorded
    const result = collectLinkedChannelIds(1, channels);
    assert.equal(result.size, 1);
    assert.ok(result.has(2));
});

test('collectLinkedChannelIds handles missing links field', () => {
    const channels = {
        1: { channel_id: 1 }
    };
    const result = collectLinkedChannelIds(1, channels);
    assert.equal(result.size, 0);
});

test('collectLinkedChannelIds avoids infinite loops from circular links', () => {
    const channels = {
        1: { channel_id: 1, links: new Set([2]) },
        2: { channel_id: 2, links: new Set([1]) }
    };
    const result = collectLinkedChannelIds(1, channels);
    // Both channels are in the set, no infinite loop
    assert.equal(result.size, 2);
    assert.ok(result.has(1));
    assert.ok(result.has(2));
});

// ---- collectSubchannelIds ----

test('collectSubchannelIds returns empty set for leaf channel', () => {
    const channels = {
        1: { channel_id: 1, parent_id: null, name: 'root' }
    };
    const result = collectSubchannelIds(1, channels);
    assert.equal(result.size, 0);
});

test('collectSubchannelIds returns direct children', () => {
    const channels = {
        1: { channel_id: 1, parent_id: null, name: 'root' },
        2: { channel_id: 2, parent_id: 1, name: 'child' }
    };
    const result = collectSubchannelIds(1, channels);
    assert.equal(result.size, 1);
    assert.ok(result.has(2));
});

test('collectSubchannelIds returns all descendants recursively', () => {
    const channels = {
        1: { channel_id: 1, parent_id: null, name: 'root' },
        2: { channel_id: 2, parent_id: 1, name: 'child' },
        3: { channel_id: 3, parent_id: 2, name: 'grandchild' }
    };
    const result = collectSubchannelIds(1, channels);
    assert.ok(result.has(2));
    assert.ok(result.has(3));
    assert.equal(result.size, 2);
});

test('collectSubchannelIds ignores unrelated channels', () => {
    const channels = {
        1: { channel_id: 1, parent_id: null, name: 'root' },
        2: { channel_id: 2, parent_id: 1, name: 'child' },
        3: { channel_id: 3, parent_id: null, name: 'other-root' }
    };
    const result = collectSubchannelIds(1, channels);
    assert.ok(result.has(2));
    assert.equal(result.size, 1);
});
