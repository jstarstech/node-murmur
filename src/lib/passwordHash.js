import crypto from 'crypto';

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
    const saltBuffer = Buffer.isBuffer(salt) ? salt : Buffer.from(salt, 'hex');
    const digest = crypto.createHash('sha1').update(saltBuffer).update(password).digest('hex');

    return `sha1$${saltBuffer.toString('hex')}$${digest}`;
}

export function verifySaltedSha1PasswordHash(password, storedHash) {
    const parts = normalizeSha1PasswordHashParts(storedHash);
    if (!parts) {
        return false;
    }

    let saltBuffer;
    try {
        saltBuffer = Buffer.from(parts.salt, 'hex');
    } catch {
        return false;
    }

    const digest = crypto.createHash('sha1').update(saltBuffer).update(password).digest('hex');
    const expected = Buffer.from(parts.digest, 'hex');
    const actual = Buffer.from(digest, 'hex');

    if (expected.length !== actual.length) {
        return false;
    }

    return crypto.timingSafeEqual(expected, actual);
}

export function generateSuperUserPassword() {
    return crypto.randomBytes(16).toString('hex');
}
