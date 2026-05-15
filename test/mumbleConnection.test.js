import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPacket, decodePacket } from '../src/lib/MumbleConnection.js';

test('buildPacket rejects unknown message names', () => {
    assert.throws(() => buildPacket('NotARealMessage', {}), /Unsupported message type/);
});

test('decodePacket rejects unknown numeric message ids', () => {
    assert.throws(() => decodePacket(999, Buffer.alloc(0)), /Unsupported message type/);
});

test('buildPacket preserves UDPTunnel payloads as raw buffers', () => {
    const payload = Buffer.from([1, 2, 3]);
    assert.equal(buildPacket('UDPTunnel', payload), payload);
});
