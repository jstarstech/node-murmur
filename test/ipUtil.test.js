import assert from 'node:assert/strict';
import test from 'node:test';
import { ipToBuffer } from '../src/lib/ipUtil.js';

test('ipToBuffer returns empty buffer for empty input', () => {
    assert.equal(ipToBuffer('').length, 0);
});

test('ipToBuffer returns empty buffer for non-string input', () => {
    assert.equal(ipToBuffer(undefined).length, 0);
    assert.equal(ipToBuffer(null).length, 0);
    assert.equal(ipToBuffer(123).length, 0);
});

test('ipToBuffer parses IPv4 addresses', () => {
    const result = ipToBuffer('192.168.1.1');
    assert.deepEqual(result, Buffer.from([192, 168, 1, 1]));
    assert.equal(result.length, 4);
});

test('ipToBuffer parses loopback IPv4', () => {
    const result = ipToBuffer('127.0.0.1');
    assert.deepEqual(result, Buffer.from([127, 0, 0, 1]));
});

test('ipToBuffer returns empty buffer for invalid IPv4', () => {
    assert.equal(ipToBuffer('999.999.999.999').length, 0);
    assert.equal(ipToBuffer('256.0.0.1').length, 0);
    assert.equal(ipToBuffer('1.2.3').length, 0);
});

test('ipToBuffer returns empty buffer for invalid IPv4 with extra parts', () => {
    assert.equal(ipToBuffer('1.2.3.4.5').length, 0);
});

test('ipToBuffer parses IPv6 loopback', () => {
    const result = ipToBuffer('::1');
    assert.equal(result.length, 16);
    assert.equal(result[15], 1);
    for (let i = 0; i < 15; i++) {
        assert.equal(result[i], 0);
    }
});

test('ipToBuffer parses full IPv6 address', () => {
    const result = ipToBuffer('2001:db8::ff00:42:8329');
    assert.equal(result.length, 16);
    assert.equal(result[0], 0x20);
    assert.equal(result[1], 0x01);
    assert.equal(result[2], 0x0d);
    assert.equal(result[3], 0xb8);
});

test('ipToBuffer parses IPv4-mapped IPv6', () => {
    const result = ipToBuffer('::ffff:192.168.1.1');
    assert.deepEqual(result, Buffer.from([192, 168, 1, 1]));
    assert.equal(result.length, 4);
});

test('ipToBuffer returns empty buffer for malformed IPv6', () => {
    assert.equal(ipToBuffer('::1::2').length, 0);
});

test('ipToBuffer returns empty buffer for unknown address format', () => {
    assert.equal(ipToBuffer('not-an-address').length, 0);
});
