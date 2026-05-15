import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import pinoPretty from 'pino-pretty';

const ROOT_DIR = path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));

class AppendFileStream {
    constructor(filePath) {
        this.filePath = filePath;
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }

    write(chunk) {
        fs.appendFileSync(this.filePath, chunk);
        return true;
    }
}

export function createLogger({
    filePath = 'mumble-server.log',
    level = process.env.LOG_LEVEL || 'trace',
    stdoutStream = process.stdout
} = {}) {
    const fileStream = new AppendFileStream(path.resolve(ROOT_DIR, filePath));
    const consoleStream =
        stdoutStream === process.stdout
            ? pinoPretty({
                  colorize: true,
                  translateTime: 'SYS:standard'
              })
            : stdoutStream;
    const streams = pino.multistream([
        { level: 'trace', stream: consoleStream },
        { level: 'trace', stream: fileStream }
    ]);

    return pino(
        {
            base: undefined,
            level,
            timestamp: pino.stdTimeFunctions.isoTime
        },
        streams
    );
}
