import assert from 'node:assert/strict';
import test from 'node:test';
import SessionPool from '../src/lib/sessionPool.js';

test('session pool uses murmur-style fifo reuse after max users window', () => {
    const pool = new SessionPool(2);

    assert.equal(pool.get(), 1);
    assert.equal(pool.get(), 2);
    assert.equal(pool.get(), 3);

    pool.reclaim(1);

    assert.equal(pool.get(), 1);
});

test('session pool throws when exhausted before any ids are reclaimed', () => {
    const pool = new SessionPool(1);

    assert.equal(pool.get(), 1);
    assert.throws(() => pool.get(), /Session ID pool exhausted/);
});
