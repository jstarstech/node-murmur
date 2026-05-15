import assert from 'node:assert/strict';
import test from 'node:test';
import { downmixChannels, fromVarint, toEventName, toFieldName, toVarint } from '../src/lib/util.js';

test('toVarint rejects non-integer values', () => {
    assert.throws(() => toVarint(1.5), TypeError);
    assert.throws(() => toVarint(Number.NaN), TypeError);
});

test('varint helpers round-trip unsigned 32-bit values', () => {
    for (const value of [0x80000000, 0xffffffff]) {
        const encoded = toVarint(value);
        const buffer = Buffer.isBuffer(encoded) ? encoded : encoded.value;
        const decoded = fromVarint(buffer);

        assert.equal(decoded.value, value);
        assert.equal(decoded.length, buffer.length);
    }
});

test('fromVarint rejects empty input', () => {
    assert.throws(() => fromVarint(Buffer.alloc(0)), TypeError);
});

test('toEventName and toFieldName split acronyms cleanly', () => {
    assert.equal(toEventName('clientOSVersion'), 'client-os-version');
    assert.equal(toFieldName('clientOSVersion'), 'client_os_version');
    assert.equal(toEventName('longHTTPHeader'), 'long-http-header');
    assert.equal(toFieldName('longHTTPHeader'), 'long_http_header');
});

test('downmixChannels writes one mono sample per frame', () => {
    const stereo = Buffer.from([1, 0, 2, 0]);
    const quad = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);

    assert.equal(downmixChannels(stereo, 2).length, 2);
    assert.equal(downmixChannels(quad, 4).length, 2);
});
