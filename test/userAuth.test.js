import assert from 'node:assert/strict';
import test from 'node:test';
import { timingSafeStringEqual } from '../src/lib/User.js';

// Guards the server-password comparison: it must remain a correct equality check
// (the constant-time property itself is not observable from a unit test).
test('timingSafeStringEqual returns true for equal strings', () => {
    assert.equal(timingSafeStringEqual('hunter2', 'hunter2'), true);
});

test('timingSafeStringEqual returns false for different strings', () => {
    assert.equal(timingSafeStringEqual('hunter2', 'hunter3'), false);
    assert.equal(timingSafeStringEqual('short', 'a much longer password'), false);
});

test('timingSafeStringEqual coerces non-string inputs without throwing', () => {
    assert.equal(timingSafeStringEqual(undefined, 'secret'), false);
    assert.equal(timingSafeStringEqual('secret', undefined), false);
});
