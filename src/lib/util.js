/**
 * @summary Converts a number to Mumble varint
 *
 * @see {@link http://mumble-protocol.readthedocs.org/en/latest/voice_data.html#variable-length-integer-encoding}
 *
 * @param i {Number} Integer to convert
 * @return {Buffer|Object} Varint encoded number
 */
export function toVarint(i) {
    if (!Number.isInteger(i) || i < -0x80000000 || i > 0xffffffff) {
        throw new TypeError(`Varints must be 32-bit integers. (${i})`);
    }

    const arr = [];

    if (i < 0) {
        i = ~i >>> 0;
        if (i <= 0x3) {
            return Buffer.from([0xfc | i]);
        }

        arr.push(0xf8);
    }

    if (i < 0x80) {
        arr.push(i);
    } else if (i < 0x4000) {
        arr.push((i >>> 8) | 0x80);
        arr.push(i & 0xff);
    } else if (i < 0x200000) {
        arr.push((i >>> 16) | 0xc0);
        arr.push((i >>> 8) & 0xff);
        arr.push(i & 0xff);
    } else if (i < 0x10000000) {
        arr.push((i >>> 24) | 0xe0);
        arr.push((i >>> 16) & 0xff);
        arr.push((i >>> 8) & 0xff);
        arr.push(i & 0xff);
    } else if (i < 0x100000000) {
        arr.push(0xf0);
        arr.push((i >>> 24) & 0xff);
        arr.push((i >>> 16) & 0xff);
        arr.push((i >>> 8) & 0xff);
        arr.push(i & 0xff);
    }

    return {
        value: Buffer.from(arr),
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
    if (!Buffer.isBuffer(b) || b.length === 0) {
        throw new TypeError('Invalid varint');
    }

    let length = 1;
    let i;
    let v = b[0];
    let ret;

    if ((v & 0x80) === 0x00) {
        i = v & 0x7f;
    } else if ((v & 0xc0) === 0x80) {
        if (b.length < 2) {
            throw new TypeError('Invalid varint');
        }

        i = ((v & 0x3f) << 8) | b[1];
        length = 2;
    } else if ((v & 0xf0) === 0xf0) {
        switch (v & 0xfc) {
            case 0xf0:
                if (b.length < 5) {
                    throw new TypeError('Invalid varint');
                }

                i = b.readUInt32BE(1);
                length = 5;
                break;
            case 0xf8:
                if (b.length < 2) {
                    throw new TypeError('Invalid varint');
                }

                ret = fromVarint(b.subarray(1));

                return {
                    value: ~ret.value,
                    length: 1 + ret.length
                };
            case 0xfc:
                i = ~(v & 0x03);
                break;
            case 0xf4:
                throw new TypeError(`64-bit varints are not supported. (${b.subarray(1, 6)})`);
            default:
                throw new TypeError('Unknown varint');
        }
    } else if ((v & 0xf0) === 0xe0) {
        if (b.length < 4) {
            throw new TypeError('Invalid varint');
        }

        i = ((v & 0x0f) * 0x1000000 + b[1] * 0x10000 + b[2] * 0x100 + b[3]) >>> 0;
        length = 4;
    } else if ((v & 0xe0) === 0xc0) {
        if (b.length < 3) {
            throw new TypeError('Invalid varint');
        }

        i = ((v & 0x1f) * 0x10000 + b[1] * 0x100 + b[2]) >>> 0;
        length = 3;
    } else {
        throw new TypeError('Unknown varint');
    }

    return {
        value: i,
        length
    };
}

export let trace = () => {},
    dir = () => {};

if (process.env.MUMBLE_TRACE) {
    trace = msg => {
        console.log(msg);
    };
    dir = data => {
        console.dir(data);
    };
}

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

function toDelimitedName(field, delimiter) {
    let result = '';

    for (let i = 0; i < field.length; i += 1) {
        const char = field[i];
        const isUpper = char >= 'A' && char <= 'Z';

        if (i > 0 && isUpper) {
            const prev = field[i - 1];
            const prevIsUpper = prev >= 'A' && prev <= 'Z';
            const prevIsLowerOrDigit = (prev >= 'a' && prev <= 'z') || (prev >= '0' && prev <= '9');
            const next = field[i + 1];
            const nextIsLower = next >= 'a' && next <= 'z';

            if (prevIsLowerOrDigit || (prevIsUpper && nextIsLower)) {
                result += delimiter;
            }
        }

        result += char;
    }

    return result.toLowerCase();
}

export function toEventName(field) {
    return toDelimitedName(field, '-');
}

export function toFieldName(field) {
    return toDelimitedName(field, '_');
}

/**
 * Downmixes multi-channel frame to mono.
 *
 * @param {Buffer} frame - Multi-channel audio frame.
 * @param {Number} channels - Number of channels.
 */
export function downmixChannels(frame, channels) {
    const monoFrame = Buffer.alloc(frame.length / channels);
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
