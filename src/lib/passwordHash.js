import crypto from 'crypto';

function parseStrictHexBuffer(value, expectedBytes = null) {
    if (typeof value !== 'string' || value.length === 0 || value.length % 2 !== 0) {
        return null;
    }

    if (!/^[0-9a-f]+$/i.test(value)) {
        return null;
    }

    if (typeof expectedBytes === 'number' && value.length !== expectedBytes * 2) {
        return null;
    }

    return Buffer.from(value, 'hex');
}

function normalizeSha1PasswordHashParts(storedHash) {
    if (typeof storedHash !== 'string') {
        return null;
    }

    const parts = storedHash.split('$');
    if (parts.length !== 3 || parts[0] !== 'sha1') {
        return null;
    }

    const [algorithm, salt, digest] = parts;
    if (algorithm !== 'sha1' || !salt || !digest) {
        return null;
    }

    return { salt, digest };
}

export function createSaltedSha1PasswordHash(password, salt = crypto.randomBytes(24)) {
    const saltBuffer = Buffer.isBuffer(salt) ? salt : parseStrictHexBuffer(salt);

    if (!saltBuffer || saltBuffer.length === 0) {
        throw new TypeError('Salt must be a non-empty Buffer or valid hex string');
    }

    const digest = crypto.createHash('sha1').update(saltBuffer).update(password).digest('hex');

    return `sha1$${saltBuffer.toString('hex')}$${digest}`;
}

export function verifySaltedSha1PasswordHash(password, storedHash) {
    const parts = normalizeSha1PasswordHashParts(storedHash);
    if (!parts) {
        return false;
    }

    const saltBuffer = parseStrictHexBuffer(parts.salt);
    if (!saltBuffer) {
        return false;
    }

    const expected = parseStrictHexBuffer(parts.digest, 20);
    if (!expected) {
        return false;
    }

    const actual = crypto.createHash('sha1').update(saltBuffer).update(password).digest();

    return crypto.timingSafeEqual(expected, actual);
}

export function generateSuperUserPassword() {
    return crypto.randomBytes(16).toString('hex');
}
