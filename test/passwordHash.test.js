import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createSaltedSha1PasswordHash,
    verifySaltedSha1PasswordHash
} from '../src/lib/passwordHash.js';

test('verifySaltedSha1PasswordHash accepts hashes created by the helper', () => {
    const hash = createSaltedSha1PasswordHash('correct horse battery staple');

    assert.equal(verifySaltedSha1PasswordHash('correct horse battery staple', hash), true);
    assert.equal(verifySaltedSha1PasswordHash('wrong password', hash), false);
});

test('verifySaltedSha1PasswordHash rejects malformed stored hash components', () => {
    assert.equal(verifySaltedSha1PasswordHash('secret', 'sha1$zz$0123456789abcdef0123456789abcdef01234567'), false);
    assert.equal(verifySaltedSha1PasswordHash('secret', 'sha1$0011$zz'), false);
    assert.equal(verifySaltedSha1PasswordHash('secret', 'sha1$0011$0123456789abcdef0123456789abcdef0123456'), false);
});

test('createSaltedSha1PasswordHash rejects malformed hex salts', () => {
    assert.throws(() => createSaltedSha1PasswordHash('secret', 'zz'), TypeError);
});
