import { EventEmitter } from 'events';
import MumbleSocket from './MumbleSocket.js';
import Messages from './MumbleMessageMap.js';
import * as util from './util.js';
import { rebuildVoicePacket } from './voice.js';
const DIR = util.dir;
const TRACE = util.trace;

/**
 * Mumble connection
 *
 * @param socket SSL socket connected to the server.
 * @param Users Users
 **/
class MumbleConnection extends EventEmitter {
    codec = { Celt: 0, Opus: 4 };
    codecValues = {};

    constructor(socket, Users) {
        super();

        Object.keys(this.codec).forEach(k => {
            this.codecValues[this.codec[k]] = k;
        });

        let self = this;
        this.socket = new MumbleSocket(socket);
        this.Users = Users;

        socket.on('close', this.disconnect.bind(this));
        socket.on('error', err => {
            self.emit('error', err);
        });

        // Start queueing for a message prefix.
        this._waitForPrefix(this);
    }

    /**
     * Send a protocol message
     *
     * @param type Message type ID
     * @param data Message data
     **/
    sendMessage(type, data) {
        DIR(data);

        // Look up the message schema by type and serialize the data into protobuf format.
        let packet = Messages.buildPacket(type, data);

        // Create the prefix.
        let prefix = Buffer.alloc(6);
        prefix.writeUInt16BE(Messages.idByName[type], 0);
        prefix.writeUInt32BE(packet.length, 2);

        this.emit('protocol-out', { type, message: data });

        // Write the message.
        this.socket.write(prefix);
        this.socket.write(packet);
    }

    /**
     * Disconnects the client from Mumble
     */
    disconnect() {
        //clearInterval( this.pingInterval );
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
        // Check whether we have a handler for this or not.
        if (!this[`_on${Messages.nameById[type]}`]) {
            TRACE(`Unhandled message:${Messages.nameById[type]}`);
            TRACE(Messages.nameById[type]);
            TRACE(msg);
        } else {
            // Handler found -> delegate.
            this[`_on${Messages.nameById[type]}`](msg);
        }

        let handlerName = Messages.nameById[type];
        handlerName = handlerName.replace(/^([A-Z]+)(?=([A-Z]?[a-z])|$)/g, (match, $1) => $1.toLowerCase());

        this.emit(handlerName, msg);
        this.emit('protocol-in', {
            handler: handlerName,
            type: Messages.nameById[type],
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
        const packet = data.packet ? Buffer.from(data.packet) : null;

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
     * Wait for a prefix on the TCP socket
     *
     * @private
     **/
    _waitForPrefix() {
        let self = this;

        // Read 6 byte prefix.
        this.socket.read(6, data => {
            let type = data.readUInt16BE(0);
            let length = data.readUInt32BE(2);

            // Read the rest of the message based on the length prefix.
            self.socket.read(length, data => {
                self._processData(type, data);

                // Wait for the next message.
                self._waitForPrefix();
            });
        });
    }
}
export default MumbleConnection;
