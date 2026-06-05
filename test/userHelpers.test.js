import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUsernameValidator } from '../src/lib/userHelpers.js';

test('buildUsernameValidator matches the default pattern', () => {
    const validate = buildUsernameValidator();
    assert.ok(validate instanceof RegExp);
    assert.ok(validate.test('alice'));
    assert.ok(validate.test('bob_123'));
    // Spaces are not part of the default username pattern.
    assert.ok(!validate.test('has space'));
});

test('buildUsernameValidator enforces the configured max length', () => {
    const validate = buildUsernameValidator(undefined, 10);
    assert.ok(validate.test('a'.repeat(10)));
    assert.ok(!validate.test('a'.repeat(11)));
});

test('buildUsernameValidator treats max length 0 as unlimited', () => {
    const validate = buildUsernameValidator(undefined, 0);
    assert.ok(validate.test('a'.repeat(5000)));
});

test('buildUsernameValidator falls back to the default pattern on invalid regex', () => {
    const validate = buildUsernameValidator('[', 50);
    assert.ok(validate instanceof RegExp);
    assert.ok(validate.test('alice'));
    assert.ok(!validate.test('a'.repeat(51)));
});
