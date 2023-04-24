const EventEmitter = require('events').EventEmitter;
const MumbleSocket = require('./MumbleSocket');
const Messages = require('./MumbleMessageMap');
const util = require('./util');
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
        let prefix = new Buffer(6);
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
        // Check whether this is an UDP packet or a protobuf message.
        if (Messages.nameById[type] === 'UDPTunnel') {
            // This is an UDP packet.
            this._onUDPTunnel(data);
        } else {
            // Protobuf message, deserialize and process.
            let msg = Messages.decodePacket(type, data);
            this._processMessage(type, msg);
        }
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
        handlerName = handlerName.replace(/^([A-Z][A-Z]*?)(?=([A-Z]?[a-z])|$)/g, (match, $1) => $1.toLowerCase());

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
        // Voice data type
        let target = data[0] & 0x1f;
        let type = (data[0] & 0xe0) >> 5;

        // Ignore the packet if we don't understand the codec value.
        if (!this.codecValues[type]) {
            return;
        }

        // Read rest of the header.
        let sequence = util.fromVarint(data.slice(1));
        let packet = data.slice(1 + sequence.length);
        let sequenceVarint = util.toVarint(sequence.value);

        let typetarget = (type << 5) | target;

        let sessionId = util.toVarint(this.sessionId);

        // Client side voice header.
        let voiceHeader = new Buffer(1 + sequenceVarint.length + sessionId.length);
        voiceHeader[0] = typetarget;
        sessionId.value.copy(voiceHeader, 1, 0);
        sequenceVarint.value.copy(voiceHeader, 2, 0);

        // UDP tunnel prefix.
        let prefix = new Buffer(6);
        prefix.writeUInt16BE(Messages.idByName.UDPTunnel, 0);
        prefix.writeUInt32BE(voiceHeader.length + packet.length, 2);

        this.Users.emit('broadcast_audio', prefix, this.sessionId);

        // Write the voice header
        this.Users.emit('broadcast_audio', voiceHeader, this.sessionId);
        this.Users.emit('broadcast_audio', packet, this.sessionId);
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

module.exports = MumbleConnection;
