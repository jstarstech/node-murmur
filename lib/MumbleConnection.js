
"use strict";

var MumbleSocket = require('./MumbleSocket');
var MumbleError = require( './MumbleError' );
var Messages = require('./MumbleMessageMap');
var util = require('./util');
var DIR = util.dir;
var TRACE = util.trace;
var WARN = util.warn;

var EventEmitter = require('events').EventEmitter;

/**
 * Mumble connection
 *
 * @param socket SSL socket connected to the server.
 **/
var MumbleConnection = function (socket, options) {
    var self = this;
    this.socket = new MumbleSocket(socket);
    this.options = options || {};

    socket.on('close', this.disconnect.bind( this ) );
    socket.on('error', function (err) {
        self.emit( 'error', err );
    });

    // Start queueing for a message prefix.
    this._waitForPrefix(this);
};
MumbleConnection.prototype = Object.create( EventEmitter.prototype );

MumbleConnection.codec = { Celt: 0, Opus: 4 };
MumbleConnection.codecValues = {};
Object.keys( MumbleConnection.codec ).forEach( function( k ) {
    MumbleConnection.codecValues[ MumbleConnection.codec[ k ] ] = k;
});

/**
 * Encodes the version to an uint8 that can be sent to the server for version-exchange
 **/
function encodeVersion(major, minor, patch) {
    return ((major & 0xffff) << 16) |  // 2 bytes major
        ((minor & 0xff) << 8) |  // 1 byte minor
        (patch & 0xff); // 1 byte patch
}

/**
 * Send a protocol message
 *
 * @param type Message type ID
 * @param data Message data
 **/
MumbleConnection.prototype.sendMessage = function (type, data) {
    DIR( data );

    // Look up the message schema by type and serialize the data into protobuf format.
    var msg = Messages.buildPacket(type, data);
    var packet = msg.toBuffer();

    // Create the prefix.
    var prefix = new Buffer(6);
    prefix.writeUInt16BE(Messages.idByName[type], 0);
    prefix.writeUInt32BE(packet.length, 2);

    this.emit( 'protocol-out', { type: type, message: data  });

    // Write the message.
    this.socket.write(prefix);
    this.socket.write(packet);
};

/**
 * Disconnects the client from Mumble
 */
MumbleConnection.prototype.disconnect = function() {
    //clearInterval( this.pingInterval );
    this.emit('disconnect');
    this.socket.end();
    this.removeAllListeners();
};

/**
 * Process incoming message
 *
 * @private
 *
 * @param type Message type ID
 * @param data Message data
 **/
MumbleConnection.prototype._processData = function (type, data) {
    // Check whether this is an UDP packet or a protobuf message.
    if( Messages.nameById[ type ] === 'UDPTunnel' ) {
        // This is an UDP packet.
        this._onUDPTunnel( data );
    } else {
        // Protobuf message, deserialize and process.
        var msg = Messages.decodePacket(type, data);
        this._processMessage( type, msg );
    }
};

/**
 * Process incoming protobuf message
 *
 * @private
 *
 * @param type Message type ID
 * @param msg Message
 **/
MumbleConnection.prototype._processMessage = function( type, msg ) {

    // Check whether we have a handler for this or not.
    if( !this[ "_on" + Messages.nameById[ type ] ] ) {
        TRACE( "Unhandled message:" + Messages.nameById[type] );
        TRACE( Messages.nameById[ type ] );
        TRACE( msg );
    } else {
        // Handler found -> delegate.
        this[ "_on" + Messages.nameById[ type ] ]( msg );
    }

    var handlerName = Messages.nameById[ type ];
    handlerName = handlerName.replace(
        /^([A-Z][A-Z]*?)(?=([A-Z]?[a-z])|$)/g,
        function( match, $1 ) {
            return $1.toLowerCase();
        });
    console.log(type, handlerName)
    this.emit( handlerName, msg );
    this.emit( 'protocol-in', {
        handler: handlerName,
        type: Messages.nameById[ type ],
        message: msg });
};

/**
 * Handle incoming voice data
 *
 * @private
 *
 * @param data Voice packet
 **/
MumbleConnection.prototype._onUDPTunnel = function( data ) {
    // Voice data type
    var target = data[0] & 0x1f;
    var type = ( data[0] & 0xe0 ) >> 5;

    // Ignore the packet if we don't understand the codec value.
    if( !MumbleConnection.codecValues[ type ] ) {
        return;
    }

    // Read rest of the header.
    var sequence = util.fromVarint( data.slice(1) );
    var packet = data.slice(1 + sequence.length);
    var sequenceVarint = util.toVarint( sequence.value );

    var session = util.toVarint( this.session_id );
    var typetarget = type << 5 | target;

    // Client side voice header.
    var voiceHeader = new Buffer( 1 + sequenceVarint.length + session.length);
    voiceHeader[0] = typetarget;
    session.value.copy( voiceHeader, 1, 0 );
    sequenceVarint.value.copy( voiceHeader, 2, 0 );

    // UDP tunnel prefix.
    var prefix = new Buffer(6);
    prefix.writeUInt16BE( Messages.idByName.UDPTunnel, 0 );
    prefix.writeUInt32BE( voiceHeader.length + packet.length, 2 );
    /*this.socket.write(prefix);

    // Write the voice header
    this.socket.write(voiceHeader);
    this.socket.write(packet);*/

    this.broadcast_audio(prefix, this.session_id);

    // Write the voice header
    this.broadcast_audio(voiceHeader, this.session_id);
    this.broadcast_audio(packet, this.session_id);
};

/**
 * Wait for a prefix on the TCP socket
 *
 * @private
 **/
MumbleConnection.prototype._waitForPrefix = function () {
    var self = this;

    // Read 6 byte prefix.
    this.socket.read(6, function (data) {
        var type = data.readUInt16BE(0);
        var length = data.readUInt32BE(2);

        // Read the rest of the message based on the length prefix.
        self.socket.read(length, function (data) {
            self._processData(type, data);

            // Wait for the next message.
            self._waitForPrefix();
        });
    });
};

module.exports = MumbleConnection;
