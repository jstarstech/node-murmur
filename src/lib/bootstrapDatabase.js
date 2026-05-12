import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sequelize } from '../models/index.js';
import { generateSelfSignedCert } from './selfSignedCert.js';
import { createSaltedSha1PasswordHash, generateSuperUserPassword } from './passwordHash.js';

const ROOT_DIR = path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
const DEFAULT_CERT_PATH = './ssl/server.cert';
const DEFAULT_KEY_PATH = './ssl/server.key';

const SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS servers (
        server_id INTEGER PRIMARY KEY
    )`,
    `CREATE TABLE IF NOT EXISTS meta (
        keystring TEXT PRIMARY KEY,
        value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS config (
        server_id INTEGER NOT NULL,
        key TEXT,
        value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS channels (
        server_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        parent_id INTEGER,
        name TEXT,
        inheritacl INTEGER,
        temporary INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS channel_info (
        server_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        key INTEGER,
        value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS acl (
        server_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        priority INTEGER,
        user_id INTEGER,
        group_name TEXT,
        apply_here INTEGER,
        apply_sub INTEGER,
        grantpriv INTEGER,
        revokepriv INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS "groups" (
        group_id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER NOT NULL,
        name TEXT,
        channel_id INTEGER NOT NULL,
        inherit INTEGER,
        inheritable INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS group_members (
        group_id INTEGER NOT NULL,
        server_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        addit INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS users (
        server_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        pw TEXT,
        lastchannel INTEGER,
        texture BLOB,
        last_active DATE
    )`,
    `CREATE TABLE IF NOT EXISTS user_info (
        server_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        key INTEGER,
        value TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS bans (
        server_id INTEGER NOT NULL,
        base BLOB,
        mask INTEGER,
        name TEXT,
        hash TEXT,
        reason TEXT,
        start DATE,
        duration INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS channel_links (
        server_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        link_id INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS slog (
        server_id INTEGER NOT NULL,
        msg TEXT,
        msgtime DATE
    )`
];

function resolvePath(relativePath) {
    return path.resolve(ROOT_DIR, relativePath);
}

function ensureParentDir(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readFileValue(value) {
    if (typeof value !== 'string' || value.length === 0) {
        return value;
    }

    const resolved = resolvePath(value);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        return fs.readFileSync(resolved, 'utf8');
    }

    return value;
}

async function createSchema() {
    for (const statement of SCHEMA_STATEMENTS) {
        await sequelize.query(statement);
    }
}

async function ensureChannelsTemporaryColumn() {
    const [rows] = await sequelize.query('PRAGMA table_info(channels)');
    const hasTemporaryColumn = Array.isArray(rows) && rows.some(row => row.name === 'temporary');

    if (!hasTemporaryColumn) {
        await sequelize.query('ALTER TABLE channels ADD COLUMN temporary INTEGER');
    }
}

async function tableRowCount(tableName) {
    const [rows] = await sequelize.query(`SELECT COUNT(*) AS count FROM ${tableName}`);
    return Number(rows?.[0]?.count || 0);
}

async function loadServerCertConfig(serverId) {
    const [rows] = await sequelize.query(
        `SELECT key, value
         FROM config
         WHERE server_id = ${Number(serverId)}
           AND key IN ('certificate', 'key')`
    );

    const config = new Map();
    for (const row of rows) {
        config.set(row.key, row.value);
    }

    return config;
}

async function storeServerCertConfig(serverId, certPath, keyPath) {
    await sequelize.query(
        `UPDATE config
         SET value = ${sequelize.escape(certPath)}
         WHERE server_id = ${Number(serverId)}
           AND key = 'certificate'`
    );

    await sequelize.query(
        `UPDATE config
         SET value = ${sequelize.escape(keyPath)}
         WHERE server_id = ${Number(serverId)}
           AND key = 'key'`
    );
}

async function ensureSelfRegisterAcl(serverId) {
    await sequelize.query(
        `UPDATE acl
         SET grantpriv = COALESCE(grantpriv, 0) | ${Number(524288)}
         WHERE server_id = ${Number(serverId)}
           AND channel_id = 0
           AND group_name = 'auth'
           AND apply_here = 1
           AND apply_sub = 1`
    );
}

async function ensureSuperUser(serverId) {
    const [rows] = await sequelize.query(
        `SELECT server_id, user_id, name, pw, lastchannel, texture, last_active
         FROM users
         WHERE server_id = ${Number(serverId)}
           AND user_id = 0
         LIMIT 1`
    );

    const existingUser = rows?.[0] || null;
    if (existingUser) {
        if (existingUser.name !== 'SuperUser') {
            await sequelize.query(
                `UPDATE users
                 SET name = 'SuperUser'
                 WHERE server_id = ${Number(serverId)}
                   AND user_id = 0`
            );
        }

        if (typeof existingUser.pw === 'string' && existingUser.pw.length > 0) {
            return { created: false, password: null };
        }
    }

    const password = generateSuperUserPassword();
    const pwHash = createSaltedSha1PasswordHash(password);
    const lastChannel = 0;

    if (existingUser) {
        await sequelize.query(
            `UPDATE users
             SET name = 'SuperUser',
                 pw = ${sequelize.escape(pwHash)},
                 lastchannel = ${sequelize.escape(lastChannel)}
             WHERE server_id = ${Number(serverId)}
               AND user_id = 0`
        );
    } else {
        await sequelize.query(
            `INSERT INTO users (server_id, user_id, name, pw, lastchannel, texture, last_active)
             VALUES (${Number(serverId)}, 0, 'SuperUser', ${sequelize.escape(pwHash)}, ${sequelize.escape(
                 lastChannel
             )}, NULL, CURRENT_TIMESTAMP)`
        );
    }

    return { created: true, password };
}

async function normalizeExistingServerCertificates(serverId) {
    const certAbsPath = resolvePath(DEFAULT_CERT_PATH);
    const keyAbsPath = resolvePath(DEFAULT_KEY_PATH);
    const config = await loadServerCertConfig(serverId);
    const certificate = config.get('certificate');
    const privateKey = config.get('key');

    if (
        typeof certificate === 'string' &&
        certificate.startsWith('-----BEGIN ') &&
        typeof privateKey === 'string' &&
        privateKey.startsWith('-----BEGIN ')
    ) {
        ensureParentDir(certAbsPath);
        ensureParentDir(keyAbsPath);
        fs.writeFileSync(certAbsPath, certificate);
        fs.writeFileSync(keyAbsPath, privateKey);
        await storeServerCertConfig(serverId, DEFAULT_CERT_PATH, DEFAULT_KEY_PATH);
        return;
    }

    const certExists = fs.existsSync(certAbsPath) && fs.statSync(certAbsPath).isFile();
    const keyExists = fs.existsSync(keyAbsPath) && fs.statSync(keyAbsPath).isFile();

    if (!certificate && !privateKey) {
        return;
    }

    if (certExists && keyExists) {
        return;
    }

    if (!certExists && !keyExists) {
        generateSelfSignedCert(certAbsPath, keyAbsPath);
        await storeServerCertConfig(serverId, DEFAULT_CERT_PATH, DEFAULT_KEY_PATH);
        return;
    }

    throw new Error(
        'Missing bootstrap TLS material. Expected ssl/server.cert and ssl/server.key to both exist or both be absent.'
    );
}

async function seedDatabase() {
    const certAbsPath = resolvePath(DEFAULT_CERT_PATH);
    const keyAbsPath = resolvePath(DEFAULT_KEY_PATH);

    const certExists = fs.existsSync(certAbsPath) && fs.statSync(certAbsPath).isFile();
    const keyExists = fs.existsSync(keyAbsPath) && fs.statSync(keyAbsPath).isFile();

    if (!certExists && !keyExists) {
        generateSelfSignedCert(certAbsPath, keyAbsPath);
    } else if (!certExists || !keyExists) {
        throw new Error(
            'Missing bootstrap TLS material. Expected ssl/server.cert and ssl/server.key to both exist or both be absent.'
        );
    }

    await sequelize.query('INSERT INTO servers (server_id) VALUES (1)');
    await sequelize.query("INSERT INTO meta (keystring, value) VALUES ('version', '5')");
    await sequelize.query(
        `INSERT INTO channels (server_id, channel_id, parent_id, name, inheritacl) VALUES
            (1, 0, NULL, 'Root', 0),
            (1, 30, 0, 'AFK', 1)`
    );
    await sequelize.query(
        `INSERT INTO "groups" (server_id, name, channel_id, inherit, inheritable) VALUES
            (1, 'admin', 0, 1, 1)`
    );
    await sequelize.query(
        `INSERT INTO acl (server_id, channel_id, priority, user_id, group_name, apply_here, apply_sub, grantpriv, revokepriv) VALUES
            (1, 0, 1, NULL, 'admin', 1, 1, 1, NULL),
            (1, 0, 2, NULL, 'auth', 1, 1, 1024, NULL),
            (1, 0, 3, NULL, 'all', 1, 0, 524288, NULL)`
    );
    await ensureSelfRegisterAcl(1);
    await sequelize.query(
        `INSERT INTO config (server_id, key, value) VALUES
            (1, 'allowhtml', 'true'),
            (1, 'bandwidth', '140000'),
            (1, 'certificate', ${sequelize.escape(DEFAULT_CERT_PATH)}),
            (1, 'certrequired', 'true'),
            (1, 'channelname', '[ \\/\\-=\\w#\\[\\]\\{\\}\\(\\)@\\|\\.]+'),
            (1, 'defaultchannel', '30'),
            (1, 'key', ${sequelize.escape(DEFAULT_KEY_PATH)}),
            (1, 'rememberchannel', 'true'),
            (1, 'textmessagelength', '5000'),
            (1, 'timeout', '30'),
            (1, 'username', '[-=\\w\\[\\]\\{\\}\\(\\)@\\|\\.]+'),
            (1, 'usersperchannel', '0'),
            (1, 'welcometext', 'Welcome to node-murmur!')`
    );

    return ensureSuperUser(1);
}

export async function ensureDatabaseReady() {
    await createSchema();
    await ensureChannelsTemporaryColumn();

    if (await tableRowCount('servers')) {
        await normalizeExistingServerCertificates(1);
        await ensureSelfRegisterAcl(1);
        const superUser = await ensureSuperUser(1);

        return {
            bootstrapped: false,
            superUserPassword: superUser.password
        };
    }

    const superUser = await seedDatabase();
    return {
        bootstrapped: true,
        superUserPassword: superUser.password
    };
}

export function resolveConfigFileValue(value) {
    return readFileValue(value);
}
