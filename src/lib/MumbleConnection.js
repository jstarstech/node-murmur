import { EventEmitter } from 'events';
import protobufjs from 'protobufjs';
import { fileURLToPath } from 'url';
import MumbleSocket from './MumbleSocket.js';
import { trace as TRACE, dir as DIR } from './util.js';
import { rebuildVoicePacket } from './voice.js';

const MESSAGE_ID_BY_NAME = Object.freeze({
    Version: 0,
    UDPTunnel: 1,
    Authenticate: 2,
    Ping: 3,
    Reject: 4,
    ServerSync: 5,
    ChannelRemove: 6,
    ChannelState: 7,
    UserRemove: 8,
    UserState: 9,
    BanList: 10,
    TextMessage: 11,
    PermissionDenied: 12,
    ACL: 13,
    QueryUsers: 14,
    CryptSetup: 15,
    ContextActionModify: 16,
    ContextAction: 17,
    UserList: 18,
    VoiceTarget: 19,
    PermissionQuery: 20,
    CodecVersion: 21,
    UserStats: 22,
    RequestBlob: 23,
    ServerConfig: 24,
    SuggestConfig: 25
});

const MESSAGE_NAME_BY_ID = Object.freeze(
    Object.fromEntries(Object.entries(MESSAGE_ID_BY_NAME).map(([name, id]) => [id, name]))
);

const PROTO_ROOT = await new Promise((resolve, reject) => {
    protobufjs.load(fileURLToPath(new URL('./Mumble.proto', import.meta.url)), (err, root) => {
        if (err) {
            reject(err);
            return;
        }

        resolve(root);
    });
});

function normalizePacketBuffer(data) {
    if (Buffer.isBuffer(data)) {
        return data;
    }

    if (data && Buffer.isBuffer(data.packet)) {
        return data.packet;
    }

    if (data && data.packet) {
        return Buffer.from(data.packet);
    }

    if (data && typeof data.length === 'number') {
        return Buffer.from(data);
    }

    return Buffer.alloc(0);
}

function getMessageType(type) {
    return PROTO_ROOT.lookupType(`MumbleProto.${type}`);
}

function getMessageName(typeId) {
    return MESSAGE_NAME_BY_ID[typeId] || null;
}

export function buildPacket(type, payload) {
    if (type === 'UDPTunnel') {
        return normalizePacketBuffer(payload);
    }

    if (typeof MESSAGE_ID_BY_NAME[type] !== 'number') {
        throw new Error(`Unsupported message type: ${type}`);
    }

    const messageType = getMessageType(type);
    return messageType.encode(messageType.create(payload || {})).finish();
}

export function decodePacket(typeId, payload) {
    if (typeId === MESSAGE_ID_BY_NAME.UDPTunnel) {
        return Buffer.from(payload || []);
    }

    const type = getMessageName(typeId);
    if (!type) {
        throw new Error(`Unsupported message type: ${typeId}`);
    }

    return getMessageType(type).decode(payload || {});
}

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

        const packet = buildPacket(type, data);
        const messageId = MESSAGE_ID_BY_NAME[type];
        const message = Buffer.alloc(6 + packet.length);

        message.writeUInt16BE(messageId, 0);
        message.writeUInt32BE(packet.length, 2);
        packet.copy(message, 6);

        this.emit('protocol-out', { type, message: data });

        // Write the message in one chunk to avoid tiny-write latency.
        this.socket.write(message);
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
        if (type === MESSAGE_ID_BY_NAME.UDPTunnel) {
            this._processMessage(type, data);
            return;
        }

        const msg = decodePacket(type, data);
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
        const messageName = getMessageName(type);
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

        const handlerName = messageName.replace(/^([A-Z]+)(?=([A-Z]?[a-z])|$)/g, (match, $1) => $1.toLowerCase());

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
        if (!Buffer.isBuffer(data) || data.length === 0) {
            return;
        }

        const voicePacket = rebuildVoicePacket(this.sessionId, data);

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
