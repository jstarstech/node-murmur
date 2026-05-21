import assert from 'node:assert/strict';
import test from 'node:test';
import { coerceServerConfigValue, DEFAULT_SERVER_CONFIG } from '../src/lib/serverConfig.js';

test('coerceServerConfigValue returns default for unknown key with empty value', () => {
    assert.equal(coerceServerConfigValue('unknown_key', null), '');
    assert.equal(coerceServerConfigValue('unknown_key', undefined), '');
});

test('coerceServerConfigValue returns string for unknown key with value', () => {
    assert.equal(coerceServerConfigValue('unknown_key', 'hello'), 'hello');
});

test('coerceServerConfigValue coerces bool keys from string', () => {
    assert.equal(coerceServerConfigValue('allowhtml', 'true'), true);
    assert.equal(coerceServerConfigValue('allowhtml', 'false'), false);
    assert.equal(coerceServerConfigValue('allowhtml', '1'), true);
    assert.equal(coerceServerConfigValue('allowhtml', '0'), false);
});

test('coerceServerConfigValue coerces bool keys from number', () => {
    assert.equal(coerceServerConfigValue('allowhtml', 1), true);
    assert.equal(coerceServerConfigValue('allowhtml', 0), false);
});

test('coerceServerConfigValue coerces bool keys from boolean', () => {
    assert.equal(coerceServerConfigValue('allowhtml', true), true);
    assert.equal(coerceServerConfigValue('allowhtml', false), false);
});

test('coerceServerConfigValue throws for invalid bool value', () => {
    assert.throws(() => coerceServerConfigValue('allowhtml', 'bad'), /Invalid value/);
    assert.throws(() => coerceServerConfigValue('allowhtml', 2), /Invalid value/);
});

test('coerceServerConfigValue returns default for empty bool', () => {
    assert.equal(coerceServerConfigValue('allowhtml', ''), DEFAULT_SERVER_CONFIG.allowhtml);
    assert.equal(coerceServerConfigValue('allowhtml', null), DEFAULT_SERVER_CONFIG.allowhtml);
});

test('coerceServerConfigValue coerces int keys from string', () => {
    assert.equal(coerceServerConfigValue('port', '64738'), 64738);
    assert.equal(coerceServerConfigValue('users', '50'), 50);
});

test('coerceServerConfigValue coerces int keys from number', () => {
    assert.equal(coerceServerConfigValue('port', 64738), 64738);
    assert.equal(coerceServerConfigValue('users', 0), 0);
});

test('coerceServerConfigValue returns default for empty int', () => {
    assert.equal(coerceServerConfigValue('port', ''), DEFAULT_SERVER_CONFIG.port);
    assert.equal(coerceServerConfigValue('port', null), DEFAULT_SERVER_CONFIG.port);
});

test('coerceServerConfigValue clamps int keys to min value', () => {
    assert.throws(() => coerceServerConfigValue('port', 0), /Invalid value/);
    assert.throws(() => coerceServerConfigValue('port', -1), /Invalid value/);
});

test('coerceServerConfigValue clamps int keys to max value', () => {
    assert.throws(() => coerceServerConfigValue('port', 65536), /Invalid value/);
});

test('coerceServerConfigValue throws for non-integer string on int key', () => {
    assert.throws(() => coerceServerConfigValue('port', 'not-a-number'), /Invalid value/);
});

test('coerceServerConfigValue throws for float on int key', () => {
    assert.throws(() => coerceServerConfigValue('users', 1.5), /Invalid value/);
});

test('coerceServerConfigValue preserves string keys', () => {
    assert.equal(coerceServerConfigValue('welcometext', 'Hello'), 'Hello');
});

test('coerceServerConfigValue returns default for null/undefined string', () => {
    assert.equal(coerceServerConfigValue('welcometext', null), DEFAULT_SERVER_CONFIG.welcometext);
    assert.equal(coerceServerConfigValue('welcometext', undefined), DEFAULT_SERVER_CONFIG.welcometext);
});

test('coerceServerConfigValue converts non-string to string', () => {
    assert.equal(coerceServerConfigValue('welcometext', 123), '123');
});

test('coerceServerConfigValue validates regex keys', () => {
    const valid = coerceServerConfigValue('channelname', '[a-z]+');
    assert.equal(valid, '[a-z]+');
});

test('coerceServerConfigValue throws for invalid regex', () => {
    assert.throws(() => coerceServerConfigValue('channelname', '[invalid'), /Invalid value/);
});

test('coerceServerConfigValue returns default for empty string on regex key', () => {
    assert.equal(coerceServerConfigValue('channelname', ''), DEFAULT_SERVER_CONFIG.channelname);
});
