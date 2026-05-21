import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isBanExpired, ipMatchesBan } from '../src/lib/banHelpers.js';

const ORIGIN = Date.now();
const HOUR = 3600;

function makeBan(overrides = {}) {
    const base = overrides.base || Buffer.alloc(16);
    return {
        base,
        mask: overrides.mask ?? 128,
        name: overrides.name || null,
        hash: overrides.hash || null,
        reason: overrides.reason || null,
        start: overrides.start ?? new Date(ORIGIN).toISOString(),
        duration: overrides.duration ?? 0,
        ...overrides
    };
}

describe('isBanExpired', () => {
    it('permanent ban never expires', () => {
        const ban = makeBan({ duration: 0, start: new Date(ORIGIN - 86400000).toISOString() });
        assert.equal(isBanExpired(ban), false);
    });

    it('returns true when ban is expired', () => {
        const ban = makeBan({ duration: 1, start: new Date(ORIGIN - 5000).toISOString() });
        assert.equal(isBanExpired(ban), true);
    });

    it('returns false when ban is still active', () => {
        const ban = makeBan({ duration: 86400, start: new Date(ORIGIN).toISOString() });
        assert.equal(isBanExpired(ban), false);
    });

    it('treats missing start as epoch', () => {
        const ban = makeBan({ start: undefined, duration: 1 });
        assert.equal(isBanExpired(ban), true);
    });
});

describe('ipMatchesBan', () => {
    function v4(...octets) {
        return Buffer.from(octets);
    }

    function v6(...groups) {
        const buf = Buffer.alloc(16);
        for (let i = 0; i < groups.length; i++) {
            buf.writeUInt16BE(groups[i] & 0xffff, i * 2);
        }
        return buf;
    }

    it('matches IPv4 address within /24 subnet', () => {
        const ban = makeBan({ base: v4(192, 168, 1, 1), mask: 24 });
        assert.equal(ipMatchesBan(v4(192, 168, 1, 50), ban), true);
    });

    it('rejects IPv4 address outside /24 subnet', () => {
        const ban = makeBan({ base: v4(192, 168, 1, 1), mask: 24 });
        assert.equal(ipMatchesBan(v4(192, 168, 2, 1), ban), false);
    });

    it('matches IPv6 address within /64 subnet', () => {
        const ban = makeBan({ base: v6(0x2a00, 0x1450, 0x400b, 0x0c00, 0, 0, 0, 0x63), mask: 64 });
        assert.equal(ipMatchesBan(v6(0x2a00, 0x1450, 0x400b, 0x0c00, 0, 0, 0, 0x54), ban), true);
    });

    it('rejects IPv6 address outside /64 subnet', () => {
        const ban = makeBan({ base: v6(0x2a00, 0x1450, 0x400b, 0x0c00, 0, 0, 0, 0x63), mask: 64 });
        assert.equal(ipMatchesBan(v6(0x2a00, 0x1450, 0x400b, 0xdead, 0x42f0, 0xcafe, 0xbabe, 0x54), ban), false);
    });

    it('returns false for mismatched address lengths', () => {
        const ban = makeBan({ base: v4(192, 168, 1, 1), mask: 24 });
        assert.equal(ipMatchesBan(v6(0x2a00, 0x1450, 0x400b, 0x0c00, 0, 0, 0, 0x54), ban), false);
    });

    it('returns false for empty address', () => {
        const ban = makeBan({ base: v4(192, 168, 1, 1), mask: 24 });
        assert.equal(ipMatchesBan(Buffer.alloc(0), ban), false);
    });

    it('matches with non-byte-aligned mask', () => {
        const ban = makeBan({ base: v4(192, 168, 1, 1), mask: 13 });
        assert.equal(ipMatchesBan(v4(192, 168, 0, 0), ban), true);
        assert.equal(ipMatchesBan(v4(192, 175, 255, 255), ban), true);
        assert.equal(ipMatchesBan(v4(192, 176, 0, 0), ban), false);
        assert.equal(ipMatchesBan(v4(192, 128, 0, 0), ban), false);
    });

    it('normalizes IPv4 to IPv4-mapped IPv6 when ban uses 16 bytes', () => {
        const ban = makeBan({
            base: Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 10, 0, 0, 1]),
            mask: 24
        });
        assert.equal(ipMatchesBan(v4(10, 0, 0, 50), ban), true);
        assert.equal(ipMatchesBan(v4(10, 0, 1, 1), ban), false);
    });
});


