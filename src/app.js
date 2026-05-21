import { Server } from './lib/Server.js';
import { createLogger } from './lib/logger.js';
import { ensureDatabaseReady } from './lib/bootstrapDatabase.js';
import { DEFAULT_SERVER_CONFIG } from './lib/serverConfig.js';
import { sequelize } from './models/index.js';
import { DATA_DIR } from './lib/paths.js';
import pkg from '../package.json' with { type: 'json' };

const activeServers = [];
let shuttingDown = false;
let log = createLogger();

async function getServerIds() {
    const [rows] = await sequelize.query('SELECT server_id FROM servers ORDER BY server_id ASC');
    return rows.map(row => Number(row.server_id)).filter(serverId => Number.isFinite(serverId) && serverId > 0);
}

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info(`Received ${signal}, shutting down gracefully...`);

    for (const server of activeServers) {
        await server.shutdown();
    }

    await Promise.race([sequelize.close(), new Promise(resolve => setTimeout(resolve, 5000))]);

    log.info('Shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

setTimeout(() => {
    if (shuttingDown) return;
    log.error('Forced shutdown after timeout');
    process.exit(1);
}, 15000).unref();

const bootstrap = await ensureDatabaseReady();

log = createLogger({ filePath: bootstrap.config?.logfile || DEFAULT_SERVER_CONFIG.logfile });

log.info('******************************************************');
log.info(`* ${`node-murmur v${pkg.version}`.padEnd(50)} *`);
log.info(`* ${'A Mumble-compatible voice server implementation'.padEnd(50)} *`);
log.info(`* ${'Documentation and issue tracking:'.padEnd(50)} *`);
log.info(`* ${'https://github.com/jstarstech/node-murmur'.padEnd(50)} *`);
log.info('******************************************************');

let serverIds;
try {
    serverIds = await getServerIds();
} catch (err) {
    if (err.parent?.code === 'SQLITE_READONLY' || err.code === 'EACCES') {
        log.error('Permission denied: Unable to read from the database.');
    } else {
        log.error({ err }, 'Failed to load servers from database');
    }
    process.exit(1);
}

if (bootstrap.configSource === 'defaults') {
    log.withDetails('warn', { configPath: bootstrap.configPath }, 'Server config file not found; using defaults');
} else {
    log.withDetails(
        'info',
        { configPath: bootstrap.configPath },
        `Initializing settings from: ${bootstrap.configPath}`
    );
}

log.info(`Data directory: ${DATA_DIR}`);

for (const warning of bootstrap.configWarnings || []) {
    log.warn(warning);
}

if (bootstrap.superUserPassword) {
    log.withDetails(
        'info',
        { serverId: serverIds[0], username: 'SuperUser', password: bootstrap.superUserPassword },
        `Password for 'SuperUser' set to '${bootstrap.superUserPassword}'`
    );
}

try {
    const instances = await Promise.all(serverIds.map(id => new Server(id, { log, sequelize }).start()));
    activeServers.push(...instances);
} catch (e) {
    if (e?.code === 'EADDRINUSE') {
        log.error(e.message);
    } else {
        log.error(e);
    }
    process.exit(1);
}
