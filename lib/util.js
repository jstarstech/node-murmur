
"use strict";

/**
 * @summary Converts a number to Mumble varint
 *
 * @see {@link http://mumble-protocol.readthedocs.org/en/latest/voice_data.html#variable-length-integer-encoding}
 *
 * @param {Number} Integer to convert
 * @return {Buffer} Varint encoded number
 */
exports.toVarint = function( i ) {
    let absValue = Math.abs( i );

    let arr = [];
    if( i < 0 ) {
        i = ~i;
        if( i <= 0x3 ) { return new Buffer([ 0xFC | i ]); }

        arr.push( 0xF8 );
    }

    if( i < 0x80 ) {
        arr.push( i );
    } else if ( i < 0x4000 ) {
        arr.push(( i >> 8 ) | 0x80 );
        arr.push(i & 0xFF );
    } else if ( i < 0x200000 ) {
        arr.push((i >> 16) | 0xC0);
        arr.push((i >> 8) & 0xFF);
        arr.push(i & 0xFF);
    } else if ( i < 0x10000000 ) {
        arr.push((i >> 24) | 0xE0);
        arr.push((i >> 16) & 0xFF);
        arr.push((i >> 8) & 0xFF);
        arr.push(i & 0xFF);
    } else if ( i < 0x100000000 ) {
        arr.push(0xF0);
        arr.push((i >> 24) & 0xFF);
        arr.push((i >> 16) & 0xFF);
        arr.push((i >> 8) & 0xFF);
        arr.push(i & 0xFF);
    } else {
        throw new TypeError( "Non-integer values are not supported. (" + i + ")" );
    }

    return {
        value: new Buffer( arr ),
        length: arr.length
    };
};

/**
 * @summary Converts a Mumble varint to an integer
 *
 * @see {@link http://mumble-protocol.readthedocs.org/en/latest/voice_data.html#variable-length-integer-encoding}
 *
 * @param {Buffer} Varint to convert
 * @return {Number} Decoded integer
 */
exports.fromVarint = function( b ) {
    let length = 1;
    let i, v = b[0];
    if(( v & 0x80) === 0x00) {
        i = (v & 0x7F);
    } else if ((v & 0xC0) === 0x80) {
        i = (v & 0x3F) << 8 | b[1];
        length = 2;
    } else if ((v & 0xF0) === 0xF0) {
        switch (v & 0xFC) {
            case 0xF0:
                i = b[1] << 24 | b[2] << 16 | b[3] << 8 | b[4];
                length = 5;
                break;
            case 0xF8:
                let ret = exports.fromVarint( b.slice(1) );
                return {
                    value: ~ret.value,
                    length: 1+ret.length
                };
            case 0xFC:
                i = v & 0x03;
                i = ~i;
                break;
            case 0xF4:
                throw new TypeError( "64-bit varints are not supported. (" + b.slice( 1, 6 ) + ")" );
            default:
                throw new TypeError( "Unknown varint" );
        }
    } else if ((v & 0xF0) === 0xE0) {
        i = (v & 0x0F) << 24 | b[1] << 16 | b[2] << 8 | b[3];
        length = 4;
    } else if ((v & 0xE0) === 0xC0) {
        i = (v & 0x1F) << 16 | b[1] << 8 | b[2];
        length = 3;
    }

    return {
        value: i,
        length: length
    };
};

if( process.env.MUMBLE_TRACE ) {
    exports.trace = function( msg ) { console.log( msg ); };
    exports.dir = function( data ) { console.dir( data ); };
    exports.warn = function( msg ) { console.log( "WARNING: " + msg ); };
} else {
    exports.trace = exports.dir = exports.warn = function() {};
}

exports.celtVersions = {
    v0_7_0: -2147483637, //  0x8000000b,
    v0_8_0: -2147483636, //  0x8000000b,
    v0_9_0: -2147483634, //  0x8000000b,
    v0_10_0: -2147483633, //  0x8000000b,
    v0_11_0: -2147483632 //  0x8000000b,
};

let permissions = {
    None: 0x00,
    Write: 0x01,
    Traverse: 0x02,
    Enter: 0x04,
    Speak: 0x08,
    MuteDeafen: 0x10,
    Move: 0x20,
    MakeChannel: 0x40,
    LinkChannel: 0x80,
    Whisper: 0x100,
    TextMessage: 0x200,
    MakeTempChannel: 0x400,

    // Root only
    Kick: 0x10000,
    Ban: 0x20000,
    Register: 0x40000,
    SelfRegister: 0x80000,

    Cached: 0x8000000,
    All: 0xf07ff
};

/**
 * Encodes the version to an uint8 that can be sent to the server for version-exchange
 **/
exports.encodeVersion = function(major, minor, patch) {
    return ((major & 0xffff) << 16) |  // 2 bytes major
        ((minor & 0xff) << 8) |  // 1 byte minor
        (patch & 0xff); // 1 byte patch
};

/**
 * @summary Read permission flags into an permission object.
 *
 * @param {Number} permissionFlags - Permission bit flags
 * @returns {Object} Permission object with the bit flags decoded.
 */
exports.readPermissions = function( permissionFlags ) {
    let result = {};
    for( let p in permissions ) {
        let mask = permissions[p];

        // Ignore the 'None' field.
        if( !mask )
            continue;

        result[ p ] = ( permissionFlags & mask ) === mask;
    }

    return result;
};

/**
 * @summary Write permission flags into an permission object.
 *
 * @param {Object} permissionObject - Permissions object
 * @returns {Number} Permission bit flags
 */
exports.writePermissions = function( permissionObject ) {
    let flags = {};
    for( let p in permissions ) {
        if( permissionObject[p] ) {
            flags |= permissions[p];
        }
    }
    return flags;
};

let eventRe = /([a-z])([A-Z])/;
exports.toEventName = function( field ) {
    return field.replace( eventRe, '$1-$2' ).toLowerCase();
};

exports.toFieldName = function( field ) {
    return field.replace( eventRe, '$1_$2' ).toLowerCase();
};


exports.findByValue = function( collection, field, value ) {

    // Check the collection for an item that has the value in the field.
    for( let key in collection ) {
        let item = collection[ key ];
        if( item[field] === value )
            return item;
    }

    // Not found. Return undefined.
};

exports.removeFrom = function( collection, item ) {
    let index = collection.indexOf( item );
    if( index !== -1 )
        collection.splice( index, 1 );
};

/**
 * Applies gain to the audio rame.
 *
 * @param {Buffer} frame - Audio frame with 16-bit samples.
 * @param {Number} gain - Multiplier for each sample.
 */
exports.applyGain = function( frame, gain ) {
    for( let i = 0; i < frame.length; i += 2 ) {
        frame.writeInt16LE( Math.floor( frame.readInt16LE( i ) * gain ), i );
    }
    return frame;
};

/**
 * Downmixes multi-channel frame to mono.
 *
 * @param {Buffer} frame - Multi-channel audio frame.
 * @param {Number} channels - Number of channels.
 */
exports.downmixChannels = function( frame, channels ) {
    let monoFrame = new Buffer( frame.length / 2 );
    let writeOffset = 0;

    for( let i = 0; i < frame.length; ) {
        let sample = 0;
        for( let c = 0; c < channels; c++, i += 2 ) {
            sample += frame.readInt16LE( i );
        }

        // Clamp the sample to the limits.
        if( sample < -(1 << 15) )
            sample = -(1 << 15);
        else if( sample > (1 << 15) - 1 )
            sample = (1 << 15) - 1;

        monoFrame.writeInt16LE( sample, writeOffset );
        writeOffset += 2;
    }

    return monoFrame;
};

/**
 * @summary Resamples the frame.
 *
 * @description
 * The resampling is done by duplicating samples every now and then so it's not
 * the best quality. Also the source/target rate conversion must result in a
 * whole number of samples for the frame size.
 *
 * @param {Buffer} frame - Original frame
 * @param {Number} sourceRate - Original sample rate
 * @param {Number} targetRate - Target sample rate
 */
exports.resample = function( frame, sourceRate, targetRate ) {

    let targetFrame = new Buffer( frame.length * targetRate / sourceRate );

    for( let t = 0; t < targetFrame.length / 2; t++ ) {

        let targetDuration = t / targetRate;
        let sourceDuration = Math.floor( targetDuration * sourceRate );
        let sourceIndex = sourceDuration * 2;
        targetFrame.writeInt16LE( frame.readInt16LE( sourceIndex ), t * 2 );
    }

    return targetFrame;
};

/**
 * @summary Rescales the frame.
 *
 * @description
 * Assuming both source and target Bit depth are multiples of eight, this function rescales the
 * frame. E.g. it can be used to make a 16 Bit audio frame of an 8 Bit audio frame.
 *
 * @param {Buffer} frame - Original frame
 * @param {Number} sourceDepth - Original Bit depth
 * @param {Boolean} sourceUnsigned - whether the source values are unsigned
 * @param {Boolean} sourceBE - whether the source values are big endian
 */
exports.rescaleToUInt16LE = function (frame, sourceDepth, sourceUnsigned, sourceBE)
{
    if (sourceDepth === 16 && !sourceUnsigned && !sourceBE)
    { return frame; }

    if (sourceDepth !== 8 && sourceDepth !== 16 && sourceDepth !== 32)
    { throw new Error('unsupported source depth ' + sourceDepth); }

    let targetFrame = new Buffer(frame.length * 16 / sourceDepth);

    let funcNameSuffix = sourceUnsigned ? 'UInt' : 'Int';
    let readFunc =
        frame[
            'read' +
            (sourceUnsigned ? 'U' : '') +
            'Int' +
            sourceDepth +
            (sourceDepth !== 8 ? (sourceBE ? 'BE' : 'LE') : '')
        ].bind(frame);

    let srcSize = Math.pow(2, sourceDepth) - 1;
    let srcOffset = sourceUnsigned ? 0 : (srcSize + 1) / -2;

    let tgtSize = sourceUnsigned ? 32767 : 65535;
    let tgtOffset = sourceUnsigned ? 0 : (tgtSize + 1) / -2;

    let factor = tgtSize / srcSize;

    let siStep = sourceDepth / 8;
    for (let si = 0, ti = 0; si < frame.length; si += siStep, ti += 2)
    { targetFrame.writeInt16LE(Math.round(tgtOffset + (readFunc(si) - srcOffset) * factor), ti); }

    return targetFrame;
};

// Gather all versions and fix the values at the same time.
let allVersions = [];
for( let i in exports.celtVersions ) {
    allVersions.push( exports.celtVersions[i] );
}
exports.celtVersions.all = allVersions;
exports.celtVersions.default = [
    exports.celtVersions.v0_7_0,
    // We don't have 0.11.0 encoder so it would be stupid to advertise it.
    // exports.celtVersions.v0_11_0,
];
