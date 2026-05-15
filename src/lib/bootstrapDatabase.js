import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sequelize } from '../models/index.js';
import { generateSelfSignedCert } from './selfSignedCert.js';
import { createSaltedSha1PasswordHash, generateSuperUserPassword } from './passwordHash.js';
import { loadServerConfig } from './serverConfig.js';

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
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (server_id, key)
    )`,
    `CREATE TABLE IF NOT EXISTS channels (
        server_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        parent_id INTEGER,
        name TEXT NOT NULL,
        inheritacl INTEGER NOT NULL DEFAULT 0,
        temporary INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (server_id, channel_id)
    )`,
    `CREATE TABLE IF NOT EXISTS channel_info (
        server_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        key INTEGER NOT NULL,
        value TEXT,
        PRIMARY KEY (server_id, channel_id, key)
    )`,
    `CREATE TABLE IF NOT EXISTS acl (
        server_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        user_id INTEGER,
        group_name TEXT,
        apply_here INTEGER NOT NULL DEFAULT 0,
        apply_sub INTEGER NOT NULL DEFAULT 0,
        grantpriv INTEGER NOT NULL DEFAULT 0,
        revokepriv INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (server_id, channel_id, priority)
    )`,
    `CREATE TABLE IF NOT EXISTS "groups" (
        group_id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        channel_id INTEGER NOT NULL,
        inherit INTEGER NOT NULL DEFAULT 0,
        inheritable INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS group_members (
        group_id INTEGER NOT NULL,
        server_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        addit INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (group_id, server_id, user_id, addit)
    )`,
    `CREATE TABLE IF NOT EXISTS users (
        server_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        pw TEXT,
        lastchannel INTEGER NOT NULL DEFAULT 0,
        texture BLOB,
        last_active DATE,
        PRIMARY KEY (server_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS user_info (
        server_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        key INTEGER NOT NULL,
        value TEXT,
        PRIMARY KEY (server_id, user_id, key)
    )`,
    `CREATE TABLE IF NOT EXISTS bans (
        server_id INTEGER NOT NULL,
        base BLOB,
        mask INTEGER NOT NULL,
        name TEXT,
        hash TEXT,
        reason TEXT,
        start DATE,
        duration INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS channel_links (
        server_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        link_id INTEGER NOT NULL,
        PRIMARY KEY (server_id, channel_id, link_id)
    )`,
    `CREATE TABLE IF NOT EXISTS slog (
        server_id INTEGER NOT NULL,
        msg TEXT,
        msgtime DATE
    )`,
    `CREATE INDEX IF NOT EXISTS idx_channels_parent
     ON channels (server_id, parent_id)`,
    `CREATE INDEX IF NOT EXISTS idx_channel_info_channel
     ON channel_info (server_id, channel_id)`,
    `CREATE INDEX IF NOT EXISTS idx_acl_channel
     ON acl (server_id, channel_id, priority)`,
    `CREATE INDEX IF NOT EXISTS idx_groups_channel
     ON "groups" (server_id, channel_id)`,
    `CREATE INDEX IF NOT EXISTS idx_group_members_group
     ON group_members (group_id)`,
    `CREATE INDEX IF NOT EXISTS idx_users_name
     ON users (server_id, name)`,
    `CREATE INDEX IF NOT EXISTS idx_user_info_user
     ON user_info (server_id, user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_channel_links_channel
     ON channel_links (server_id, channel_id)`,
    `CREATE INDEX IF NOT EXISTS idx_bans_server_start
     ON bans (server_id, start)`
];

function resolvePath(relativePath) {
    return path.resolve(ROOT_DIR, relativePath);
}

function buildBootstrapResult(serverConfigFile, bootstrapped, superUserPassword = null) {
    return {
        bootstrapped,
        config: serverConfigFile.config,
        configPath: serverConfigFile.path,
        configSource: serverConfigFile.exists ? 'file' : 'defaults',
        configWarnings: serverConfigFile.warnings,
        superUserPassword
    };
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

async function hasOfficialBootstrap(serverId) {
    const [rows] = await sequelize.query(
        `SELECT COUNT(*) AS count
         FROM config
         WHERE server_id = ${Number(serverId)}
           AND key IN ('sslCert', 'sslKey')`
    );

    return Number(rows?.[0]?.count || 0) >= 2;
}

async function resetBootstrapData() {
    await sequelize.transaction(async transaction => {
        const tables = [
            'channel_links',
            'bans',
            'user_info',
            'users',
            'group_members',
            '"groups"',
            'acl',
            'channel_info',
            'channels',
            'config',
            'slog',
            'servers',
            'meta'
        ];

        for (const table of tables) {
            await sequelize.query(`DELETE FROM ${table}`, { transaction });
        }

        await sequelize.query(`DELETE FROM sqlite_sequence WHERE name = 'groups'`, { transaction });
    });
}

async function loadServerCertConfig(serverId) {
    const [rows] = await sequelize.query(
        `SELECT key, value
         FROM config
         WHERE server_id = ${Number(serverId)}
           AND key IN ('sslCert', 'sslKey')`
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
           AND key = 'sslCert'`
    );

    await sequelize.query(
        `UPDATE config
         SET value = ${sequelize.escape(keyPath)}
         WHERE server_id = ${Number(serverId)}
           AND key = 'sslKey'`
    );
}

async function syncConfigRows(serverId, config, transaction) {
    const rows = Object.entries(config).map(([key, value]) => ({
        server_id: Number(serverId),
        key,
        value: String(value)
    }));

    for (const row of rows) {
        await sequelize.query(
            `INSERT INTO config (server_id, key, value)
             VALUES (${sequelize.escape(row.server_id)}, ${sequelize.escape(row.key)}, ${sequelize.escape(row.value)})
             ON CONFLICT(server_id, key)
             DO UPDATE SET value = excluded.value`,
            { transaction }
        );
    }
}

async function ensureSelfRegisterAcl(serverId, transaction) {
    await sequelize.query(
        `UPDATE acl
         SET grantpriv = COALESCE(grantpriv, 0) | ${Number(524288)}
         WHERE server_id = ${Number(serverId)}
           AND channel_id = 0
           AND group_name = 'auth'
           AND apply_here = 1
           AND apply_sub = 1`,
        { transaction }
    );
}

async function ensureSuperUser(serverId, transaction) {
    const [rows] = await sequelize.query(
        `SELECT server_id, user_id, name, pw, lastchannel, texture, last_active
         FROM users
         WHERE server_id = ${Number(serverId)}
          AND user_id = 0
         LIMIT 1`,
        { transaction }
    );

    const existingUser = rows?.[0] || null;
    if (existingUser) {
        if (existingUser.name !== 'SuperUser') {
            await sequelize.query(
                `UPDATE users
                 SET name = 'SuperUser'
                 WHERE server_id = ${Number(serverId)}
                   AND user_id = 0`,
                { transaction }
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
               AND user_id = 0`,
            { transaction }
        );
    } else {
        await sequelize.query(
            `INSERT INTO users (server_id, user_id, name, pw, lastchannel, texture, last_active)
             VALUES (${Number(serverId)}, 0, 'SuperUser', ${sequelize.escape(pwHash)}, ${sequelize.escape(
                 lastChannel
             )}, NULL, CURRENT_TIMESTAMP)`,
            { transaction }
        );
    }

    return { created: true, password };
}

async function normalizeExistingServerCertificates(serverId) {
    const certAbsPath = resolvePath(DEFAULT_CERT_PATH);
    const keyAbsPath = resolvePath(DEFAULT_KEY_PATH);
    const config = await loadServerCertConfig(serverId);
    const certificate = config.get('sslCert');
    const privateKey = config.get('sslKey');

    if (
        typeof certificate === 'string' &&
        certificate.startsWith('-----BEGIN ') &&
        typeof privateKey === 'string' &&
        privateKey.startsWith('-----BEGIN ')
    ) {
        fs.mkdirSync(path.dirname(certAbsPath), { recursive: true });
        fs.mkdirSync(path.dirname(keyAbsPath), { recursive: true });
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

async function seedDatabase(serverConfig) {
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

    return sequelize.transaction(async transaction => {
        await sequelize.query('INSERT INTO servers (server_id) VALUES (1)', { transaction });
        await sequelize.query("INSERT INTO meta (keystring, value) VALUES ('version', '5')", { transaction });
        await sequelize.query(
            `INSERT INTO channels (server_id, channel_id, parent_id, name, inheritacl) VALUES
                (1, 0, NULL, 'Root', 0),
                (1, 30, 0, 'AFK', 1)`,
            { transaction }
        );
        await sequelize.query(
            `INSERT INTO "groups" (server_id, name, channel_id, inherit, inheritable) VALUES
                (1, 'admin', 0, 1, 1)`,
            { transaction }
        );
        await sequelize.query(
            `INSERT INTO acl (server_id, channel_id, priority, user_id, group_name, apply_here, apply_sub, grantpriv, revokepriv) VALUES
                (1, 0, 1, NULL, 'admin', 1, 1, 1, 0),
                (1, 0, 2, NULL, 'auth', 1, 1, 1024, 0),
                (1, 0, 3, NULL, 'all', 1, 0, 524288, 0)`,
            { transaction }
        );
        await ensureSelfRegisterAcl(1, transaction);

        await syncConfigRows(1, serverConfig, transaction);

        return ensureSuperUser(1, transaction);
    });
}

export async function ensureDatabaseReady() {
    const serverConfigFile = loadServerConfig();

    await createSchema();
    await ensureChannelsTemporaryColumn();

    if (await tableRowCount('servers')) {
        if (!(await hasOfficialBootstrap(1))) {
            await resetBootstrapData();
            const superUser = await seedDatabase(serverConfigFile.config);

            return buildBootstrapResult(serverConfigFile, true, superUser.password);
        }

        await syncConfigRows(1, serverConfigFile.config);
        await normalizeExistingServerCertificates(1);
        await ensureSelfRegisterAcl(1);
        const superUser = await ensureSuperUser(1);

        return buildBootstrapResult(serverConfigFile, false, superUser.password);
    }

    const superUser = await seedDatabase(serverConfigFile.config);
    return buildBootstrapResult(serverConfigFile, true, superUser.password);
}

export function resolveConfigFileValue(value) {
    return readFileValue(value);
}
