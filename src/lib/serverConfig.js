import fs from 'fs';
import path from 'path';
import ini from 'ini';
import { fileURLToPath } from 'url';

const ROOT_DIR = path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));

export const SERVER_CONFIG_PATH = path.resolve(ROOT_DIR, 'mumble-server.ini');

const DEFAULT_CHANNEL_NAME_PATTERN = '[ \\/\\-=\\w#\\[\\]\\{\\}\\(\\)@\\|\\.]+';
const DEFAULT_USERNAME_PATTERN = '[-=\\w\\[\\]\\{\\}\\(\\)@\\|\\.]+';
const DEFAULT_WELCOME_TEXT = 'Welcome to this server running Mumble.\nEnjoy your stay!';
const DEFAULT_SSL_CERT = './ssl/server.cert';
const DEFAULT_SSL_KEY = './ssl/server.key';

const SCHEMA = {
    allowhtml: { type: 'bool', default: true },
    allowping: { type: 'bool', default: true },
    autobanAttempts: { type: 'int', default: 10, min: 0 },
    autobanSuccessfulConnections: { type: 'bool', default: true },
    autobanTime: { type: 'int', default: 300, min: 0 },
    autobanTimeframe: { type: 'int', default: 120, min: 0 },
    bandwidth: { type: 'int', default: 558000, min: 0 },
    bonjour: { type: 'bool', default: true },
    certrequired: { type: 'bool', default: false },
    channelcountlimit: { type: 'int', default: 1000, min: 0 },
    channelname: { type: 'regex', default: DEFAULT_CHANNEL_NAME_PATTERN },
    channelnestinglimit: { type: 'int', default: 10, min: 0 },
    database: { type: 'string', default: '' },
    dbDriver: { type: 'string', default: 'sqlite' },
    dbHost: { type: 'string', default: '' },
    dbPassword: { type: 'string', default: '' },
    dbPort: { type: 'string', default: '' },
    dbUsername: { type: 'string', default: '' },
    defaultchannel: { type: 'int', default: 0, min: 0 },
    ice: { type: 'string', default: '' },
    icesecretread: { type: 'string', default: '' },
    icesecretwrite: { type: 'string', default: '' },
    imagemessagelength: { type: 'int', default: 1048576, min: 0 },
    kdfiterations: { type: 'int', default: -1, min: -1 },
    legacypasswordhash: { type: 'bool', default: false },
    logfile: { type: 'string', default: 'mumble-server.log' },
    logaclchanges: { type: 'bool', default: false },
    logdays: { type: 'int', default: 31, min: -1 },
    loggroupchanges: { type: 'bool', default: false },
    messagelimit: { type: 'int', default: 1, min: 1 },
    messageburst: { type: 'int', default: 5, min: 1 },
    obfuscate: { type: 'bool', default: false },
    opusthreshold: { type: 'int', default: 0, min: 0, max: 100 },
    pidfile: { type: 'string', default: '' },
    pluginmessageburst: { type: 'int', default: 5, min: 1 },
    pluginmessagelimit: { type: 'int', default: 1, min: 1 },
    port: { type: 'int', default: 64738, min: 1, max: 65535 },
    registerHostname: { type: 'string', default: '' },
    registerLocation: { type: 'string', default: '' },
    registerName: { type: 'string', default: '' },
    registerPassword: { type: 'string', default: '' },
    registerUrl: { type: 'string', default: '' },
    rememberchannel: { type: 'bool', default: true },
    rememberchannelduration: { type: 'int', default: 0, min: 0 },
    sendversion: { type: 'bool', default: true },
    serverpassword: { type: 'string', default: '' },
    sqlite_wal: { type: 'int', default: 0, min: 0, max: 2 },
    sslCA: { type: 'string', default: '' },
    sslCert: { type: 'string', default: DEFAULT_SSL_CERT },
    sslCiphers: {
        type: 'string',
        default: 'EECDH+AESGCM:EDH+aRSA+AESGCM:DHE-RSA-AES256-SHA:DHE-RSA-AES128-SHA:AES256-SHA:AES128-SHA'
    },
    sslDHParams: { type: 'string', default: '@ffdhe2048' },
    sslKey: { type: 'string', default: DEFAULT_SSL_KEY },
    sslPassPhrase: { type: 'string', default: '' },
    suggestPositional: { type: 'string', default: '' },
    suggestPushToTalk: { type: 'string', default: '' },
    suggestVersion: { type: 'string', default: '' },
    textmessagelength: { type: 'int', default: 5000, min: 0 },
    timeout: { type: 'int', default: 30, min: 0 },
    uname: { type: 'string', default: '' },
    username: { type: 'regex', default: DEFAULT_USERNAME_PATTERN },
    users: { type: 'int', default: 100, min: 0 },
    usersperchannel: { type: 'int', default: 0, min: 0 },
    welcometext: { type: 'string', default: DEFAULT_WELCOME_TEXT },
    welcometextfile: { type: 'string', default: '' },
    host: { type: 'string', default: '' }
};

export const DEFAULT_SERVER_CONFIG = Object.freeze(
    Object.fromEntries(Object.entries(SCHEMA).map(([key, spec]) => [key, spec.default]))
);

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseInteger(key, value, spec) {
    if (value === '' || value === null || typeof value === 'undefined') {
        return spec.default;
    }

    if (typeof value === 'number' && Number.isInteger(value)) {
        if ((typeof spec.min === 'number' && value < spec.min) || (typeof spec.max === 'number' && value > spec.max)) {
            throw new Error(`Invalid value for ${key}: ${value}`);
        }

        return value;
    }

    if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) {
        throw new Error(`Invalid value for ${key}: ${value}`);
    }

    const parsed = Number.parseInt(value, 10);

    if ((typeof spec.min === 'number' && parsed < spec.min) || (typeof spec.max === 'number' && parsed > spec.max)) {
        throw new Error(`Invalid value for ${key}: ${value}`);
    }

    return parsed;
}

function parseBoolean(key, value, spec) {
    if (value === '' || value === null || typeof value === 'undefined') {
        return spec.default;
    }

    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'number' && (value === 0 || value === 1)) {
        return Boolean(value);
    }

    if (typeof value !== 'string') {
        throw new Error(`Invalid value for ${key}: ${value}`);
    }

    if (value === 'true' || value === '1') {
        return true;
    }

    if (value === 'false' || value === '0') {
        return false;
    }

    throw new Error(`Invalid value for ${key}: ${value}`);
}

function parseString(value, spec) {
    if (value === null || typeof value === 'undefined') {
        return spec.default;
    }

    if (value === '') {
        return '';
    }

    if (typeof value === 'string') {
        return value;
    }

    return String(value);
}

function parseRegex(key, value, spec) {
    const parsed = parseString(value, spec);

    if (parsed === '') {
        return spec.default;
    }

    try {
        new RegExp(parsed);
    } catch {
        throw new Error(`Invalid value for ${key}: ${parsed}`);
    }

    return parsed;
}

export function coerceServerConfigValue(key, value) {
    const spec = SCHEMA[key];

    if (!spec) {
        if (value === null || typeof value === 'undefined') {
            return '';
        }

        return typeof value === 'string' ? value : String(value);
    }

    switch (spec.type) {
        case 'bool':
            return parseBoolean(key, value, spec);
        case 'int':
            return parseInteger(key, value, spec);
        case 'regex':
            return parseRegex(key, value, spec);
        case 'string':
        default:
            return parseString(value, spec);
    }
}

export function buildDefaultServerConfig(overrides = {}) {
    const config = { ...DEFAULT_SERVER_CONFIG };

    for (const [key, value] of Object.entries(overrides || {})) {
        config[key] = coerceServerConfigValue(key, value);
    }

    return config;
}

export function loadServerConfig(configPath = SERVER_CONFIG_PATH) {
    const exists = fs.existsSync(configPath) && fs.statSync(configPath).isFile();

    if (!exists) {
        return {
            config: buildDefaultServerConfig(),
            exists: false,
            path: configPath,
            warnings: []
        };
    }

    let parsed;
    try {
        parsed = ini.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
        throw new Error(`Failed to parse server config ${configPath}: ${error.message}`, { cause: error });
    }

    const warnings = [];
    const config = buildDefaultServerConfig();

    for (const [key, value] of Object.entries(parsed || {})) {
        if (isPlainObject(value) || Array.isArray(value)) {
            throw new Error(`Invalid server config ${configPath}: sections are not supported (${key})`);
        }

        if (!Object.prototype.hasOwnProperty.call(SCHEMA, key)) {
            warnings.push(`Unknown server config key "${key}" in ${configPath}; preserving value.`);
        }

        config[key] = coerceServerConfigValue(key, value);
    }

    return {
        config,
        exists: true,
        path: configPath,
        warnings
    };
}
