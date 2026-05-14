import { EventEmitter } from 'events';
import MumbleSocket from './MumbleSocket.js';
import Messages from './MumbleMessageMap.js';
import { toEventName, trace as TRACE, dir as DIR } from './util.js';
import { rebuildVoicePacket } from './voice.js';

/**
 * Mumble connection
 *
 * @param socket SSL socket connected to the server.
 * @param Users Users
 **/
class MumbleConnection extends EventEmitter {
    constructor(socket, Users) {
        super();

        this.socket = new MumbleSocket(socket);
        this.Users = Users;
        this.state = 'connected';

        socket.on('close', () => {
            this.disconnect();
        });
        socket.on('error', err => {
            this.emit('error', err);
        });

        this._readLoop();
    }

    /**
     * Send a protocol message
     *
     * @param type Message type ID
     * @param data Message data
     **/
    sendMessage(type, data) {
        DIR(data);

        let packet;

        if (type === 'UDPTunnel') {
            if (Buffer.isBuffer(data)) {
                packet = data;
            } else if (data && Buffer.isBuffer(data.packet)) {
                packet = data.packet;
            } else if (data && data.packet) {
                packet = Buffer.from(data.packet);
            } else if (data && typeof data.length === 'number') {
                packet = Buffer.from(data);
            } else {
                packet = Buffer.alloc(0);
            }
        } else {
            // Look up the message schema by type and serialize the data into protobuf format.
            packet = Messages.buildPacket(type, data);
        }

        // Create the packet prefix.
        const prefix = Buffer.allocUnsafe(6);
        prefix.writeUInt16BE(Messages.idByName[type], 0);
        prefix.writeUInt32BE(packet.length, 2);

        this.emit('protocol-out', { type, message: data });

        // Write the message in one chunk to avoid tiny-write latency.
        this.socket.write(Buffer.concat([prefix, packet]));
    }

    /**
     * Disconnects the client from Mumble
     */
    disconnect() {
        if (this.state === 'dead') {
            return;
        }

        this.state = 'dead';
        this.emit('disconnect');
        this.socket.end();
        this.removeAllListeners();
    }

    /**
     * Process incoming message
     *
     * @private
     *
     * @param type Message type ID
     * @param data Message data
     **/
    _processData(type, data) {
        if (type === Messages.idByName.UDPTunnel) {
            this._processMessage(type, data);
            return;
        }

        const msg = Messages.decodePacket(type, data);
        this._processMessage(type, msg);
    }

    /**
     * Process incoming protobuf message
     *
     * @private
     *
     * @param type Message type ID
     * @param msg Message
     **/
    _processMessage(type, msg) {
        const messageName = Messages.nameById[type];
        if (!messageName) {
            TRACE(`Unhandled message type: ${type}`);
            TRACE(msg);
            return;
        }

        const handler = this[`_on${messageName}`];

        if (!handler) {
            TRACE(`Unhandled message:${messageName}`);
            TRACE(messageName);
            TRACE(msg);
        } else {
            handler.call(this, msg);
        }

        const handlerName = toEventName(messageName);

        this.emit(handlerName, msg);
        this.emit('protocol-in', {
            handler: handlerName,
            type: messageName,
            message: msg
        });
    }

    /**
     * Handle incoming voice data
     *
     * @private
     *
     * @param data Voice packet
     **/
    _onUDPTunnel(data) {
        const packet = Buffer.isBuffer(data) ? data : data?.packet ? Buffer.from(data.packet) : null;

        if (!packet) {
            return;
        }

        const voicePacket = rebuildVoicePacket(this.sessionId, packet);

        if (!voicePacket) {
            return;
        }

        this.Users.emit('broadcast_audio', voicePacket, this.sessionId);
    }

    /**
     * Read and process framed protocol messages until the socket closes.
     *
     * @private
     **/
    async _readLoop() {
        try {
            while (this.state !== 'dead') {
                const prefix = await this.socket.read(6);

                if (this.state === 'dead') {
                    return;
                }

                const type = prefix.readUInt16BE(0);
                const length = prefix.readUInt32BE(2);
                const data = length > 0 ? await this.socket.read(length) : Buffer.alloc(0);

                if (this.state === 'dead') {
                    return;
                }

                this._processData(type, data);
            }
        } catch (err) {
            if (this.state !== 'dead') {
                this.emit('error', err);
            }
        } finally {
            if (this.state !== 'dead') {
                this.disconnect();
            }
        }
    }
}
export default MumbleConnection;
