/**
 * Mumble network protocol wrapper for an SSL socket
 *
 * @private
 *
 * @constructor
 * @this {MumbleSocket}
 * @param {Socket} socket
 *     SSL socket to be wrapped.
 *     The socket must be connected to the Mumble server.
 */
class MumbleSocket {
    constructor(socket) {
        this.buffers = [];
        this.readers = [];
        this.length = 0;
        this.socket = socket;
        this.closed = false;
        this.closeError = null;

        // Register the data callback to receive data from Mumble server.
        socket.on('data', data => {
            this.receiveData(data);
        });
        socket.on('end', () => {
            this.close();
        });
        socket.on('timeout', () => {
            this.close(new Error('Socket timed out'));
        });
        socket.on('error', err => {
            this.close(err);
        });
    }

    /**
     * Handle incoming data from the socket
     *
     * @param {Buffer} data Incoming data buffer
     */
    receiveData(data) {
        if (this.closed) {
            return;
        }

        // Insert the data into the buffer queue.
        this.buffers.push(data);
        this.length += data.length;

        // Drain every reader that can be satisfied by the buffered data.
        this._drainReaders();
    }

    /**
     * Queue a reader for incoming data.
     *
     * @param {number} length The amount of data this reader expects
     * @returns {Promise<Buffer>} The requested data buffer
     */
    read(length) {
        if (!Number.isInteger(length) || length < 0) {
            return Promise.reject(new TypeError(`Invalid read length: ${length}`));
        }

        if (this.closed) {
            return Promise.reject(this.closeError || new Error('Socket is closed'));
        }

        return new Promise((resolve, reject) => {
            this.readers.push({ length, resolve, reject });
            this._drainReaders();
        });
    }

    /**
     * Write message into the socket
     *
     * @param {Buffer} buffer Message to write
     */
    write(buffer) {
        // Just in case the function is call when we are disconnecting, we need to check if the socket is still writable
        if (this.socket.writable) {
            this.socket.write(buffer);
        }
    }

    /**
     * Close the socket
     */
    end() {
        this.socket.end();
    }

    /**
     * Close the socket wrapper and fail any pending reads.
     *
     * @private
     *
     * @param {Error} [error] Close reason
     */
    close(error = null) {
        if (this.closed) {
            return;
        }

        this.closed = true;
        this.closeError = error instanceof Error ? error : new Error('Socket is closed');

        for (const reader of this.readers) {
            reader.reject(this.closeError);
        }

        this.readers.length = 0;

        this.buffers.length = 0;
        this.length = 0;
    }

    /**
     * Check whether there's enough data to satisfy queued readers.
     *
     * @private
     */
    _drainReaders() {
        while (!this.closed && this.readers.length > 0) {
            const reader = this.readers[0];

            if (this.length < reader.length) {
                return;
            }

            if (reader.length === 0) {
                this.readers.shift();
                reader.resolve(Buffer.alloc(0));
                continue;
            }

            // Allocate the buffer for the reader.
            const buffer = Buffer.alloc(reader.length);
            let written = 0;

            // Gather the buffered fragments into the output buffer.
            while (written < reader.length) {
                const received = this.buffers[0];
                const remaining = reader.length - written;

                if (received.length <= remaining) {
                    received.copy(buffer, written);
                    written += received.length;
                    this.buffers.shift();
                    this.length -= received.length;
                } else {
                    received.copy(buffer, written, 0, remaining);
                    this.buffers[0] = received.slice(remaining);
                    this.length -= remaining;
                    written += remaining;
                }
            }

            this.readers.shift();
            reader.resolve(buffer);
        }
    }
}

export default MumbleSocket;
