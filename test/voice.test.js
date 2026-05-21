import assert from 'node:assert/strict';
import test from 'node:test';
import { toVarint } from '../src/lib/util.js';
import { getVoiceKind, getVoiceTarget, rebuildVoicePacket } from '../src/lib/voice.js';

function v(value) {
    const encoded = toVarint(value);
    return Buffer.isBuffer(encoded) ? encoded : encoded.value;
}

test('getVoiceKind returns null for empty packet', () => {
    assert.equal(getVoiceKind(null), null);
    assert.equal(getVoiceKind(Buffer.alloc(0)), null);
});

test('getVoiceKind extracts kind from header byte', () => {
    const packet = Buffer.from([(1 << 5) | 0]);
    assert.equal(getVoiceKind(packet), 1);
});

test('getVoiceKind extracts ping kind', () => {
    const packet = Buffer.from([(0 << 5) | 0]);
    assert.equal(getVoiceKind(packet), 0);
});

test('getVoiceTarget returns null for empty packet', () => {
    assert.equal(getVoiceTarget(null), null);
    assert.equal(getVoiceTarget(Buffer.alloc(0)), null);
});

test('getVoiceTarget extracts target from header byte', () => {
    const packet = Buffer.from([(1 << 5) | 5]);
    assert.equal(getVoiceTarget(packet), 5);
});

test('getVoiceTarget extracts max target (31)', () => {
    const packet = Buffer.from([(1 << 5) | 31]);
    assert.equal(getVoiceTarget(packet), 31);
});

test('rebuildVoicePacket returns null for empty data', () => {
    assert.equal(rebuildVoicePacket(1, null), null);
    assert.equal(rebuildVoicePacket(1, Buffer.alloc(0)), null);
});

test('rebuildVoicePacket returns null for invalid voice type', () => {
    const input = Buffer.concat([Buffer.from([(5 << 5) | 1]), v(1), Buffer.from([0x01])]);
    assert.equal(rebuildVoicePacket(1, input), null);
});

test('rebuildVoicePacket returns null for type 1 (speech)', () => {
    const input = Buffer.concat([Buffer.from([(1 << 5) | 0]), v(1), Buffer.from([0x01])]);
    assert.equal(rebuildVoicePacket(1, input), null);
});

test('rebuildVoicePacket rebuilds whisper (type 2) with session and sequence varints', () => {
    const input = Buffer.concat([Buffer.from([(2 << 5) | 3]), v(42), Buffer.from([0xAA, 0xBB])]);
    const result = rebuildVoicePacket(7, input);

    assert.notEqual(result, null);
    assert.equal(result[0], (2 << 5) | 3);
});

test('rebuildVoicePacket includes target and type in output header for type 0', () => {
    const input = Buffer.concat([Buffer.from([(0 << 5) | 0]), v(10), Buffer.from([0x01])]);
    const result = rebuildVoicePacket(5, input);

    assert.notEqual(result, null);
    assert.equal(result[0], (0 << 5) | 0);
});

test('rebuildVoicePacket handles multi-byte varint sequence', () => {
    const input = Buffer.concat([Buffer.from([(0 << 5) | 0]), v(200), Buffer.alloc(0)]);
    const result = rebuildVoicePacket(1, input);

    assert.notEqual(result, null);
    assert.equal(result[0], (0 << 5) | 0);
});

test('rebuildVoicePacket handles multi-byte varint session', () => {
    const input = Buffer.concat([Buffer.from([(2 << 5) | 1]), v(5), Buffer.from([0x01])]);
    const result = rebuildVoicePacket(200, input);

    assert.notEqual(result, null);
    assert.equal(result[0], (2 << 5) | 1);
});

test('rebuildVoicePacket rebuilds type 3', () => {
    const input = Buffer.concat([Buffer.from([(3 << 5) | 0]), v(1), Buffer.alloc(0)]);
    const result = rebuildVoicePacket(1, input);

    assert.notEqual(result, null);
    assert.equal(result[0], (3 << 5) | 0);
});

test('rebuildVoicePacket rebuilds type 4', () => {
    const input = Buffer.concat([Buffer.from([(4 << 5) | 0]), v(1), Buffer.alloc(0)]);
    const result = rebuildVoicePacket(1, input);

    assert.notEqual(result, null);
    assert.equal(result[0], (4 << 5) | 0);
});
