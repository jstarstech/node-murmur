import fs from 'fs';
import path from 'path';
import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { DEFAULT_LOG_FILE, ROOT_DIR } from './paths.js';

class AppendFileStream {
    constructor(filePath) {
        this.filePath = filePath;
        this.permissionError = false;

        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            // Check if the file is writable by attempting to open it
            fs.closeSync(fs.openSync(filePath, 'a'));
        } catch (err) {
            if (err.code === 'EACCES') {
                this.permissionError = true;
            } else {
                throw err;
            }
        }
    }

    write(chunk) {
        if (this.permissionError) {
            return true;
        }

        try {
            fs.appendFileSync(this.filePath, chunk);
        } catch (err) {
            if (err.code === 'EACCES') {
                this.permissionError = true;
            } else {
                throw err;
            }
        }
        return true;
    }
}

export function createLogger({
    filePath = process.env.LOG_FILE || DEFAULT_LOG_FILE,
    level = process.env.LOG_LEVEL || 'info',
    stdoutStream = process.stdout
} = {}) {
    const absoluteFilePath = path.resolve(ROOT_DIR, filePath);
    const fileStream = new AppendFileStream(absoluteFilePath);
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

    const logger = pino(
        {
            base: undefined,
            level,
            timestamp: pino.stdTimeFunctions.isoTime
        },
        streams
    );

    if (fileStream.permissionError) {
        logger.error(`Permission denied: Unable to write to the log file (${absoluteFilePath}).`);
    }

    logger.withDetails = (logLevel, details, message) => {
        if (logger.isLevelEnabled('debug')) {
            logger[logLevel](details, message);
            return;
        }

        logger[logLevel](message);
    };

    return logger;
}
