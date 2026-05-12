import fs from 'fs';
import path from 'path';
import pino from 'pino';
import pinoPretty from 'pino-pretty';

export class AppendFileStream {
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
    filePath = 'logs/main.log',
    level = process.env.LOG_LEVEL || 'trace',
    stdoutStream = process.stdout
} = {}) {
    const fileStream = new AppendFileStream(filePath);
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
