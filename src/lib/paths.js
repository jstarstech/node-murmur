import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT_DIR = path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
export const DATA_DIR = path.join(ROOT_DIR, 'data');

export const DEFAULT_CONFIG_FILE = path.join(DATA_DIR, 'mumble-server.ini');
export const DEFAULT_SQLITE_FILE = path.join(DATA_DIR, 'mumble-server.sqlite');
export const DEFAULT_LOG_FILE = path.join(DATA_DIR, 'mumble-server.log');
export const DEFAULT_CERT_FILE = path.join(DATA_DIR, 'server.cert');
export const DEFAULT_KEY_FILE = path.join(DATA_DIR, 'server.key');

export function resolveFromRoot(relativePath) {
    return path.resolve(ROOT_DIR, relativePath);
}
