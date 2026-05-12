import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT_DIR = path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
const BLOB_DIR = path.resolve(ROOT_DIR, 'db', 'blobstore');

function ensureBlobDir() {
    fs.mkdirSync(BLOB_DIR, { recursive: true });
}

function getBlobPath(hash) {
    return path.join(BLOB_DIR, hash);
}

export function isBlobHash(value) {
    return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

export async function putBlob(data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), 'utf8');
    const hash = crypto.createHash('sha1').update(buffer).digest('hex');

    ensureBlobDir();

    const blobPath = getBlobPath(hash);
    if (!fs.existsSync(blobPath)) {
        fs.writeFileSync(blobPath, buffer);
    }

    return hash;
}

export async function putTextBlob(text) {
    return putBlob(Buffer.from(String(text ?? ''), 'utf8'));
}

export async function getBlob(hash) {
    if (!isBlobHash(hash)) {
        return null;
    }

    const blobPath = getBlobPath(hash);
    if (!fs.existsSync(blobPath)) {
        return null;
    }

    return fs.readFileSync(blobPath);
}

export async function getTextBlob(hash) {
    const blob = await getBlob(hash);
    if (!blob) {
        return null;
    }

    return blob.toString('utf8');
}
