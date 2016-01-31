
"use strict";

var jitter = require('jitterbuffer');
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

    // Set up the ping loop.
    //this.pingInterval = setInterval(function () { self._ping(); }, 1000);

    // Member fields.
    this.channels = {};
    this.users = {};
    this.packetBuffer = new Buffer( this.FRAME_SIZE * 2 );
    this.voiceBuffer = [];
    this.voiceBufferLength = 0;
    this.voiceSequence = 0;
    this.authSent = false;

    this.lastProcess = Date.now();
    this.processInterval = setInterval( this._processAudio.bind( this ), this.FRAME_LENGTH );

    // Initialize the debug files if we specified MUMBLE_FILEOUT option.
    if( process.env.MUMBLE_FILEOUT ) {
        var fs = require('fs');
        var fname = process.env.MUMBLE_FILEOUT;
        this.out_pcm = fs.createWriteStream( fname + "_out.pcm" );
        this.out_celt = fs.createWriteStream( fname + "_out.celt" );
        this.in_celt = fs.createWriteStream( fname + "_in.celt" );
        this.in_jitter_celt = fs.createWriteStream( fname + "_in_jitter.celt" );
    }

    // Start waiting for the init messages.
    this.initPending = [ 'ServerSync','ServerConfig' ];

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
 * Join a channel specified by a Mumble URL
 *
 * @param url Mumble URL
 **/
MumbleConnection.prototype.joinPath = function ( path ) {

    var channel = this.rootChannel;
    for( var i in path ) {
        if( path[i] === '' ) { continue; }
        var segment = decodeURIComponent( path[i] );
        var nextChannel = this._findChannel( channel.channel_id, segment, true );
        if( nextChannel === null ) { WARN( 'Path not found!' ); break; }
        channel = nextChannel;
    }

    // Send a new user state to update the current channel.
    this.sendMessage( 'UserState', { session: this.sessionId, actor: this.sessionId, channel_id: channel.channel_id });
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

    // Check initialization state.
    if( this.initPending ) {
        var initIndex = this.initPending.indexOf( Messages.nameById[ type ] );
        if( initIndex !== -1 ) { this.initPending.splice( initIndex, 1 ); }

        if( this.initPending.length === 0 ) {
            this.initialize();
            TRACE('Mumble connection initialized.');
            this.initPending = null;
            this.emit( 'initialized', this );
        }
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
 * Propagate permission denied errors
 *
 * @private
 *
 * @param data Details about the error
 **/
MumbleConnection.prototype._onPermissionDenied = function (data) {
    this.emit('permission-denied', data);
    this._onError( 'PermissionDenied', data );
};

/**
 * Propagate rejects
 *
 * @private
 *
 * @param {Object} data - Error details
 */
MumbleConnection.prototype._onReject = function( data ) {
    this.emit( 'reject', data );
    this._onError( 'Reject', data );
};

/**
 * Emit the generic error event.
 *
 * @private
 *
 * @param {String} name - Error name
 * @param {Objec} data - Error details
 */
MumbleConnection.prototype._onError = function( name, data ) {

    var error = new MumbleError( name, data );

    // Make sure the error event is handled.
    if( this.listeners( 'error' ).length === 0 )
        throw error;

    this.emit( 'error', error );
};

/**
 * Handle ping message
 *
 * @private
 *
 * @param msg Ping message
 **/
MumbleConnection.prototype._onPing = function () {
    // Just to get rid of "Unhandled message" spam on Ping
    // TODO: Add disconnect on ping timeout.
};

/**
 * Handle channel state message
 *
 * @private
 *
 * @param channelData Channel state message
 **/
MumbleConnection.prototype._onChannelState = function ( channelData ) {

    // See if we know of this channel already.
    var channel = this.channels[ channelData.channel_id ];
    if( !channel ) {

        // This is a new channel, add it to the collection.
        channel = { channel_id: channelData.channel_id, parent: channelData.parent };
        this.channels[ channelData.channel_id ] = channel;

        // Update the rootChannel if this channel doesn't have a parent.
        if( channel.parent === null ) {
            this.rootChannel = channel;
        }
    }

    // Copy the new values to the previous channel.
    for( var i in channelData ) {
        channel[ i ] = channelData[ i ];
    }

};

/**
 * Handle user state message
 *
 * @private
 *
 * @param userState User state message
 */
MumbleConnection.prototype._onUserState = function ( userState ) {

    var user = this.users[ userState.session ];
    if( !user ) {
        user = this.users[ userState.session ] = {
            talking: false,
            session: userState.session,
            buffer: new jitter.JitterBuffer( 10 )
        };

        user.buffer.setMargin(10);
    }

    // Copy the new values to the previous user.
    for( var i in userState ) {
        user[ i ] = userState[ i ];
    }

    this.emit( 'user-update', user );
};

/**
 * Handle server sync message
 *
 * @private
 *
 * @param syncData Server sync message
 **/
MumbleConnection.prototype._onServerSync = function ( syncData ) {
    this.sessionId = syncData.session;

    // Overhead based on Mumble client settings at 10ms per packet.
    var overhead = 29000;
    this.setBitrate( syncData.max_bandwidth - overhead );
};

/**
 * Handle the reject message
 *
 * @private
 *
 * @param reject Reject message
 **/
MumbleConnection.prototype._onReject = function ( reject ) {
    var emitted = false;

    // Emit the specific event.
    if( this.listeners( 'error' + reject.type ).length ) {
        this.emit( 'error' + reject.type, reject );
        emitted = true;
    }

    // Emit the error event.
    if( this.listeners( 'error' ).length ) {
        this.emit( 'error', reject );
        emitted = true;
    }

    // If this report wasn't handled in any way throw an exception.
    if( !emitted ) {
        throw new Error( reject.type + ': ' + reject.reason );
    }
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
    if( !MumbleConnection.codecValues[ type ] )
        return;

    // Read rest of the header.
    var session = util.fromVarint( data.slice(1) );
    var sequence = util.fromVarint( data.slice(1 + session.length) );
    var packet = data.slice(1 + session.length + sequence.length);

    var user = this.users[ session.value ];
    if( !user ) { return; }

    // Read the audio frames.
    sequence = sequence.value;
    var moreFrames = true;
    while( moreFrames && packet.length > 0 ) {

        // Audio frame header.
        var headerLength, frameLength, terminateAudio;
        var header;
        if( type === MumbleConnection.codec.Celt ) {

            // Celt header is two bytes.
            header = packet[0];

            headerLength = 1;
            frameLength = header & 0x7F;
            terminateAudio = ( frameLength === 0 );
            moreFrames = ( header & 0x80 );

        } else if( type === MumbleConnection.codec.Opus ) {

            // Opus header is two bytes.
            var headerVarint = util.fromVarint( packet );
            header = headerVarint.value;

            headerLength = headerVarint.length;
            frameLength = header & 0x1FFF;
            terminateAudio = header & 0x2000;
            moreFrames = false;
        }
        var frame = packet.slice( headerLength, headerLength + frameLength );
        terminateAudio = terminateAudio ? 1 : 0;

        // Put the packet in the jitter buffer.
        var jitterPacket = {
            data: frame,
            timestamp: sequence * this.FRAME_LENGTH,
            span: this.FRAME_LENGTH,
            sequence: sequence++,
            userData: ( terminateAudio << 7 ) | type,
        };
        user.buffer.put( jitterPacket );
        user.voiceActive = true;

        // Write debug information if we got a debug file.
        if( this.in_celt ) { this.in_celt.write( packet ); }

        // Slice the current packet off the buffer and repeat.
        packet = packet.slice( headerLength + frameLength );
    }
};


/**
 * Processes the incoming audio queue
 *
 * @private
 **/
MumbleConnection.prototype._processAudio = function() {
    var self = this;

    while( this.lastProcess + this.FRAME_LENGTH < Date.now() ) {
        var user, packet;
        var packets = this._dequeueFrames();

        // Update the user talk-state.
        for( var p in packets ) {
            packet = packets[p];
            user = packet.user;

            //console.log( packet );
            if( packet.frame && !user.talking ) {
                user.talking = true;
                this.emit( 'voice-start', { session: user.session, name: user.name, talking: true } );
            }

            if( packet.terminator ) {
                user.talking = false;
                user.voiceActive = false;
                this.emit( 'voice-end', { session: user.session, name: user.name, talking: false } );
            }
        }

        for( var u in this.users ) {
            user = this.users[ u ];
            if( user.talking && user.missedFrames > 20 ) {
                user.talking = false;
                user.voiceActive = false;
                this.emit( 'voice-end', { session: user.session, name: user.name, talking: false } );
            }
        }

        this.emit( 'voice-frame', packets );


        // We got listeners for voice event so do decode.
        var decoded = [];
        var decodedUser = {};
        for( var f in packets ) {
            packet = packets[f];
            user = packet.user;

            // Make sure there are listeners for the voice event before decoding.
            if( this.listeners( 'voice' ).length === 0 &&
                this.listeners( 'voice-user-' + user.session ).length === 0 ) {

                continue;
            }

            // Decode the packet using the correct decoder based on the packet
            // codec.

            var decoder = this._getDecoder( user, packet.codec );
            var data = decoder.decode( packets[f].frame );

            var decodedPacket = {
                data: data,
                codec: packet.codec,
                session: packet.session
            };

            decodedUser[ user.session ] = decodedUser[ user.session ] || [];
            decodedUser[ user.session ].push( decodedPacket );
            decoded.push( decodedPacket );
        }

        if( decoded.length > 0 ) {

            // Emit the premix event as it's cheap.
            Object.keys( decodedUser ).forEach( function( key ) {
                var packets = decodedUser[ key ];
                for( var p in packets ) {
                    self.emit('voice-user-' + key, packets[ p ].data );
                }
            });

            // The voice event is more expensive as it requires mixing audio.
            // Emit it only if we know there's someone listening.
            if( this.listeners('voice').length > 0 ) {

                var mixed = this._mix( decoded );
                this.emit( 'voice', mixed );
            }
        }

        this.lastProcess += this.FRAME_LENGTH;
    }
};

/**
 * Dequeue the next frames for each user from the Jitterbuffer
 *
 * @private
 */
MumbleConnection.prototype._dequeueFrames = function() {

    var packets = [];
    for( var i in this.users ) {
        var user = this.users[i];

        // Get the frame for the user
        var frame = user.buffer.get( this.FRAME_LENGTH );

        var packet = {
            user: user,
            session: user.session,
        };

        // Set the frame data of the packet depending on the jitterbuffer
        // result.
        if( frame.data ) {

            // Use the dequeued data.
            packet.frame = frame.data;
            packet.codec = frame.userData & 0x7f;
            packet.terminator = ( frame.userData & 0x80 ) > 0;
            packets.push( packet );

            // Store this as the last successful frame so we can use it
            // if the jitterbuffer is getting low on buffered content.
            user.lastFrame = frame.packet;
            user.missedFrames = 0;

        } else if( frame === jitter.INSERTION && user.lastFrame ) {

            // If the jitterbuffer wants to pad the buffer,
            // duplicate the last frame as the fake frame.
            packet.frame = user.lastFrame.frame;
            packet.codec = user.lastFrame.codec;
            packets.push( packet );

            user.missedFrames++;
        } else {
            user.missedFrames++;
        }

        user.buffer.tick();
    }

    return packets;
};

/**
 * Mix a punch of different audio buffers into one
 *
 * @private
 *
 * @param {Buffer} decoded Decoded audio sample buffers
 * @return {Buffer} Mixed audio sample buffer
 */
MumbleConnection.prototype._mix = function( decoded ) {

    var mixed;

    // There's a good chance there will be only one speaker.
    // At this point we don't need to do mixing at all.
    // Just use that one frame as it is.
    if( decoded.length === 1 ) {
        mixed = decoded[0].data;
    } else {

        // Multiple speakers. Mix the frames.
        mixed = new Buffer( this.FRAME_SIZE * 2 );
        for( var i = 0; i < this.FRAME_SIZE; i++ ) {

            // Sum the sample
            var sum = 0;
            for( var d in decoded ) {
                sum += decoded[d].data.readInt16LE( i*2 );
            }

            // Truncate the sum to 16-bit
            // TODO: These are just quick limits. Fix them for min/max values.
            if( sum > 1 << 14 ) { sum = 1 << 14; }
            if( -sum > 1 << 14 ) { sum = -(1 << 14); }

            mixed.writeInt16LE( sum, i*2 );
        }
    }

    return mixed;
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

/**
 * Send the ping message
 *
 * @private
 **/
MumbleConnection.prototype._ping = function () {
    this.sendMessage('Ping', { timestamp: Date.now() });
};

/**
 * Look up a channel by channel name under a parent
 *
 * @private
 *
 * @param parentId Parent channel ID
 * @param name Channel name to be looked up
 * @param caseInsensitive true to perform case insensitive name comparison
 **/
MumbleConnection.prototype._findChannel = function( parentId, name, caseInsensitive ) {
    if( caseInsensitive ) { name = name.toLowerCase(); }

    for( var i in this.channels ) {
        var c = this.channels[i];
        var key = c.name;
        if( caseInsensitive ) { key = key.toLowerCase(); }
        if( c.parent === parentId && key === name ) { return c; }
    }

    return null;
};

module.exports = MumbleConnection;
