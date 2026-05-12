/**
 * @summary Converts a number to Mumble varint
 *
 * @see {@link http://mumble-protocol.readthedocs.org/en/latest/voice_data.html#variable-length-integer-encoding}
 *
 * @param i {Number} Integer to convert
 * @return {Buffer|Object} Varint encoded number
 */
export function toVarint(i) {
    const arr = [];

    if (i < 0) {
        i = ~i;
        if (i <= 0x3) {
            return new Buffer([0xfc | i]);
        }

        arr.push(0xf8);
    }

    if (i < 0x80) {
        arr.push(i);
    } else if (i < 0x4000) {
        arr.push((i >> 8) | 0x80);
        arr.push(i & 0xff);
    } else if (i < 0x200000) {
        arr.push((i >> 16) | 0xc0);
        arr.push((i >> 8) & 0xff);
        arr.push(i & 0xff);
    } else if (i < 0x10000000) {
        arr.push((i >> 24) | 0xe0);
        arr.push((i >> 16) & 0xff);
        arr.push((i >> 8) & 0xff);
        arr.push(i & 0xff);
    } else if (i < 0x100000000) {
        arr.push(0xf0);
        arr.push((i >> 24) & 0xff);
        arr.push((i >> 16) & 0xff);
        arr.push((i >> 8) & 0xff);
        arr.push(i & 0xff);
    } else {
        throw new TypeError(`Non-integer values are not supported. (${i})`);
    }

    return {
        value: new Buffer(arr),
        length: arr.length
    };
}

/**
 * @summary Converts a Mumble varint to an integer
 *
 * @see {@link http://mumble-protocol.readthedocs.org/en/latest/voice_data.html#variable-length-integer-encoding}
 *
 * @param b {Buffer} Varint to convert
 * @return {Object} Decoded integer
 */
export function fromVarint(b) {
    let length = 1;
    let i;
    let v = b[0];
    let ret;

    if ((v & 0x80) === 0x00) {
        i = v & 0x7f;
    } else if ((v & 0xc0) === 0x80) {
        i = ((v & 0x3f) << 8) | b[1];
        length = 2;
    } else if ((v & 0xf0) === 0xf0) {
        switch (v & 0xfc) {
            case 0xf0:
                i = (b[1] << 24) | (b[2] << 16) | (b[3] << 8) | b[4];
                length = 5;
                break;
            case 0xf8:
                ret = fromVarint(b.subarray(1));

                return {
                    value: ~ret.value,
                    length: 1 + ret.length
                };
            case 0xfc:
                i = v & 0x03;
                i = ~i;
                break;
            case 0xf4:
                throw new TypeError(`64-bit varints are not supported. (${b.subarray(1, 6)})`);
            default:
                throw new TypeError('Unknown varint');
        }
    } else if ((v & 0xf0) === 0xe0) {
        i = ((v & 0x0f) << 24) | (b[1] << 16) | (b[2] << 8) | b[3];
        length = 4;
    } else if ((v & 0xe0) === 0xc0) {
        i = ((v & 0x1f) << 16) | (b[1] << 8) | b[2];
        length = 3;
    }

    return {
        value: i,
        length
    };
}

export let trace = () => {},
    dir = () => {},
    warn = () => {};

if (process.env.MUMBLE_TRACE) {
    trace = msg => {
        console.log(msg);
    };
    dir = data => {
        console.dir(data);
    };
    warn = msg => {
        console.log(`WARNING: ${msg}`);
    };
}

export const celtVersions = {
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
export function encodeVersion(major, minor, patch) {
    return (
        // 1 byte patch
        // 1 byte minor
        ((major & 0xffff) << 16) | // 2 bytes major
        ((minor & 0xff) << 8) |
        (patch & 0xff)
    );
}

/**
 * @summary Read permission flags into a permission object.
 *
 * @param {Number} permissionFlags - Permission bit flags
 * @returns {Object} Permission object with the bit flags decoded.
 */
export function readPermissions(permissionFlags) {
    let result = {};
    for (let p in permissions) {
        let mask = permissions[p];

        // Ignore the 'None' field.
        if (!mask) continue;

        result[p] = (permissionFlags & mask) === mask;
    }

    return result;
}

/**
 * @summary Write permission flags into a permission object.
 *
 * @param {Object} permissionObject - Permissions object
 * @returns {Number} Permission bit flags
 */
export function writePermissions(permissionObject) {
    let flags = {};
    for (let p in permissions) {
        if (permissionObject[p]) {
            flags |= permissions[p];
        }
    }
    return flags;
}

const eventRe = /([a-z])([A-Z])/;

export function toEventName(field) {
    return field.replace(eventRe, '$1-$2').toLowerCase();
}

export function toFieldName(field) {
    return field.replace(eventRe, '$1_$2').toLowerCase();
}

export function findByValue(collection, field, value) {
    // Check the collection for an item that has the value in the field.
    for (let key in collection) {
        let item = collection[key];
        if (item[field] === value) return item;
    }

    // Not found. Return undefined.
}

export function removeFrom(collection, item) {
    let index = collection.indexOf(item);
    if (index !== -1) collection.splice(index, 1);
}

/**
 * Applies gain to the audio rame.
 *
 * @param {Buffer} frame - Audio frame with 16-bit samples.
 * @param {Number} gain - Multiplier for each sample.
 */
export function applyGain(frame, gain) {
    for (let i = 0; i < frame.length; i += 2) {
        frame.writeInt16LE(Math.floor(frame.readInt16LE(i) * gain), i);
    }
    return frame;
}

/**
 * Downmixes multi-channel frame to mono.
 *
 * @param {Buffer} frame - Multi-channel audio frame.
 * @param {Number} channels - Number of channels.
 */
export function downmixChannels(frame, channels) {
    let monoFrame = new Buffer(frame.length / 2);
    let writeOffset = 0;

    for (let i = 0; i < frame.length; ) {
        let sample = 0;
        for (let c = 0; c < channels; c++, i += 2) {
            sample += frame.readInt16LE(i);
        }

        // Clamp the sample to the limits.
        if (sample < -(1 << 15)) sample = -(1 << 15);
        else if (sample > (1 << 15) - 1) sample = (1 << 15) - 1;

        monoFrame.writeInt16LE(sample, writeOffset);
        writeOffset += 2;
    }

    return monoFrame;
}

/**
 * @summary Resamples the frame.
 *
 * @description
 * The resampling is done by duplicating samples sometimes, so it's not
 * the best quality. Also, the source/target rate conversion must result in a
 * whole number of samples for the frame size.
 *
 * @param {Buffer} frame - Original frame
 * @param {Number} sourceRate - Original sample rate
 * @param {Number} targetRate - Target sample rate
 */
export function resample(frame, sourceRate, targetRate) {
    let targetFrame = new Buffer((frame.length * targetRate) / sourceRate);

    for (let t = 0; t < targetFrame.length / 2; t++) {
        let targetDuration = t / targetRate;
        let sourceDuration = Math.floor(targetDuration * sourceRate);
        let sourceIndex = sourceDuration * 2;
        targetFrame.writeInt16LE(frame.readInt16LE(sourceIndex), t * 2);
    }

    return targetFrame;
}

/**
 * @summary Rescales the frame.
 *
 * @description
 * Assuming both source and target Bit depth are multiples of eight, this function rescales the
 * frame. E.g. it can be used to make a 16-Bit audio frame of an 8-Bit audio frame.
 *
 * @param {Buffer} frame - Original frame
 * @param {Number} sourceDepth - Original Bit depth
 * @param {Boolean} sourceUnsigned - whether the source values are unsigned
 * @param {Boolean} sourceBE - whether the source values are big endian
 */
export function rescaleToUInt16LE(frame, sourceDepth, sourceUnsigned, sourceBE) {
    if (sourceDepth === 16 && !sourceUnsigned && !sourceBE) {
        return frame;
    }

    if (sourceDepth !== 8 && sourceDepth !== 16 && sourceDepth !== 32) {
        throw new Error(`unsupported source depth ${sourceDepth}`);
    }

    let targetFrame = new Buffer((frame.length * 16) / sourceDepth);

    let readFunc =
        frame[
            `read${sourceUnsigned ? 'U' : ''}Int${sourceDepth}${sourceDepth !== 8 ? (sourceBE ? 'BE' : 'LE') : ''}`
        ].bind(frame);

    let srcSize = 2 ** sourceDepth - 1;
    let srcOffset = sourceUnsigned ? 0 : (srcSize + 1) / -2;

    let tgtSize = sourceUnsigned ? 32767 : 65535;
    let tgtOffset = sourceUnsigned ? 0 : (tgtSize + 1) / -2;

    let factor = tgtSize / srcSize;

    let siStep = sourceDepth / 8;
    for (let si = 0, ti = 0; si < frame.length; si += siStep, ti += 2) {
        targetFrame.writeInt16LE(Math.round(tgtOffset + (readFunc(si) - srcOffset) * factor), ti);
    }

    return targetFrame;
}

// Gather all versions and fix the values at the same time.
const allVersions = [];
for (const i in celtVersions) {
    allVersions.push(celtVersions[i]);
}

export default {
    ...celtVersions,
    all: allVersions,
    default: celtVersions.v0_7_0,
    trace,
    dir,
    warn
};
