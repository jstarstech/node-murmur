import crypto from 'crypto';
import nacl from 'tweetnacl';

const MODE_OCB2 = 'OCB2-AES128';
const MODE_XSALSA = 'XSalsa20-Poly1305';
const BLOCK_SIZE = 16;
const OCB_TAG_SIZE = 3;
const IV_HISTORY_SIZE = 0x100;

function xorBlock(dst, a, b) {
    for (let i = 0; i < BLOCK_SIZE; i += 1) {
        dst[i] = a[i] ^ b[i];
    }
}

function cloneBlock(block) {
    return Buffer.from(block);
}

function times2(block) {
    const src = cloneBlock(block);
    const carry = (src[0] >> 7) & 1;

    for (let i = 0; i < BLOCK_SIZE - 1; i += 1) {
        block[i] = ((src[i] << 1) & 0xfe) | ((src[i + 1] >> 7) & 0x01);
    }
    block[BLOCK_SIZE - 1] = ((src[BLOCK_SIZE - 1] << 1) & 0xfe) ^ (carry * 0x87);
}

function times3(block) {
    const src = cloneBlock(block);
    const carry = (src[0] >> 7) & 1;

    for (let i = 0; i < BLOCK_SIZE - 1; i += 1) {
        block[i] = src[i] ^ (((src[i] << 1) & 0xfe) | ((src[i + 1] >> 7) & 0x01));
    }
    block[BLOCK_SIZE - 1] = src[BLOCK_SIZE - 1] ^ (((src[BLOCK_SIZE - 1] << 1) & 0xfe) ^ (carry * 0x87));
}

function aesBlockEncrypt(key, block) {
    const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
    cipher.setAutoPadding(false);

    return Buffer.concat([cipher.update(block), cipher.final()]);
}

function aesBlockDecrypt(key, block) {
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(false);

    return Buffer.concat([decipher.update(block), decipher.final()]);
}

class Ocb2Mode {
    constructor() {
        this.key = null;
    }

    nonceSize() {
        return BLOCK_SIZE;
    }

    keySize() {
        return BLOCK_SIZE;
    }

    overhead() {
        return OCB_TAG_SIZE;
    }

    setKey(key) {
        if (key.length !== this.keySize()) {
            throw new Error('cryptstate: invalid key length');
        }

        this.key = Buffer.from(key);
    }

    encrypt(dst, src, nonce) {
        if (!this.key) {
            throw new Error('cryptstate: key not initialized');
        }

        if (nonce.length !== this.nonceSize()) {
            throw new Error('cryptstate: bad nonce length');
        }

        if (dst.length <= this.overhead()) {
            throw new Error('cryptstate: bad dst');
        }

        const tag = dst.subarray(0, OCB_TAG_SIZE);
        const out = dst.subarray(OCB_TAG_SIZE);
        const checksum = Buffer.alloc(BLOCK_SIZE);
        const delta = aesBlockEncrypt(this.key, nonce);
        const tmp = Buffer.alloc(BLOCK_SIZE);
        const pad = Buffer.alloc(BLOCK_SIZE);
        const calcTag = Buffer.alloc(BLOCK_SIZE);

        let off = 0;
        let remain = src.length;

        while (remain > BLOCK_SIZE) {
            times2(delta);
            xorBlock(tmp, delta, src.subarray(off, off + BLOCK_SIZE));
            const encrypted = aesBlockEncrypt(this.key, tmp);
            xorBlock(out.subarray(off, off + BLOCK_SIZE), delta, encrypted);
            xorBlock(checksum, checksum, src.subarray(off, off + BLOCK_SIZE));

            remain -= BLOCK_SIZE;
            off += BLOCK_SIZE;
        }

        times2(delta);
        tmp.fill(0);
        const num = remain * 8;
        tmp[BLOCK_SIZE - 2] = (num >> 8) & 0xff;
        tmp[BLOCK_SIZE - 1] = num & 0xff;
        xorBlock(tmp, tmp, delta);
        pad.set(aesBlockEncrypt(this.key, tmp));

        const finalBlock = Buffer.alloc(BLOCK_SIZE);
        src.copy(finalBlock, 0, off, off + remain);
        pad.copy(finalBlock, remain, remain, BLOCK_SIZE);
        xorBlock(checksum, checksum, finalBlock);
        xorBlock(finalBlock, pad, finalBlock);
        finalBlock.copy(out, off, 0, remain);

        times3(delta);
        xorBlock(tmp, delta, checksum);
        aesBlockEncrypt(this.key, tmp).copy(calcTag);
        calcTag.copy(tag, 0, 0, OCB_TAG_SIZE);
    }

    decrypt(dst, src, nonce) {
        if (!this.key) {
            throw new Error('cryptstate: key not initialized');
        }

        if (nonce.length !== this.nonceSize()) {
            throw new Error('cryptstate: bad nonce length');
        }

        if (src.length <= this.overhead()) {
            throw new Error('cryptstate: bad src');
        }

        const tag = src.subarray(0, OCB_TAG_SIZE);
        const encrypted = src.subarray(OCB_TAG_SIZE);
        const checksum = Buffer.alloc(BLOCK_SIZE);
        const delta = aesBlockEncrypt(this.key, nonce);
        const tmp = Buffer.alloc(BLOCK_SIZE);
        const pad = Buffer.alloc(BLOCK_SIZE);
        const calcTag = Buffer.alloc(BLOCK_SIZE);

        let off = 0;
        let remain = encrypted.length;

        while (remain > BLOCK_SIZE) {
            times2(delta);
            xorBlock(tmp, delta, encrypted.subarray(off, off + BLOCK_SIZE));
            const decrypted = aesBlockDecrypt(this.key, tmp);
            xorBlock(dst.subarray(off, off + BLOCK_SIZE), delta, decrypted);
            xorBlock(checksum, checksum, dst.subarray(off, off + BLOCK_SIZE));

            off += BLOCK_SIZE;
            remain -= BLOCK_SIZE;
        }

        times2(delta);
        tmp.fill(0);
        const num = remain * 8;
        tmp[BLOCK_SIZE - 2] = (num >> 8) & 0xff;
        tmp[BLOCK_SIZE - 1] = num & 0xff;
        xorBlock(tmp, tmp, delta);
        pad.set(aesBlockEncrypt(this.key, tmp));

        tmp.fill(0);
        encrypted.copy(tmp, 0, off, off + remain);
        xorBlock(tmp, tmp, pad);
        xorBlock(checksum, checksum, tmp);
        tmp.copy(dst, off, 0, remain);

        times3(delta);
        xorBlock(tmp, delta, checksum);
        aesBlockEncrypt(this.key, tmp).copy(calcTag);

        if (!crypto.timingSafeEqual(calcTag.subarray(0, OCB_TAG_SIZE), tag)) {
            return false;
        }

        return true;
    }
}

class SecretBoxMode {
    constructor() {
        this.key = null;
    }

    nonceSize() {
        return 24;
    }

    keySize() {
        return 32;
    }

    overhead() {
        return nacl.secretbox.overheadLength;
    }

    setKey(key) {
        if (key.length !== this.keySize()) {
            throw new Error('cryptstate: invalid key length');
        }

        this.key = new Uint8Array(key);
    }

    encrypt(dst, src, nonce) {
        if (!this.key) {
            throw new Error('cryptstate: key not initialized');
        }

        if (nonce.length !== this.nonceSize()) {
            throw new Error('cryptstate: bad nonce length');
        }

        if (dst.length <= this.overhead()) {
            throw new Error('cryptstate: bad dst');
        }

        const boxed = nacl.secretbox(new Uint8Array(src), new Uint8Array(nonce), this.key);
        if (!boxed) {
            throw new Error('cryptstate: secretbox encrypt failed');
        }

        dst.set(Buffer.from(boxed), 0);
    }

    decrypt(dst, src, nonce) {
        if (!this.key) {
            throw new Error('cryptstate: key not initialized');
        }

        if (nonce.length !== this.nonceSize()) {
            throw new Error('cryptstate: bad nonce length');
        }

        if (src.length <= this.overhead()) {
            throw new Error('cryptstate: bad src');
        }

        const opened = nacl.secretbox.open(new Uint8Array(src), new Uint8Array(nonce), this.key);
        if (!opened) {
            return false;
        }

        dst.set(Buffer.from(opened), 0);
        return true;
    }
}

function createMode(mode) {
    switch (mode) {
        case MODE_OCB2:
            return new Ocb2Mode();
        case MODE_XSALSA:
            return new SecretBoxMode();
        default:
            throw new Error('cryptstate: no such CryptoMode');
    }
}

export const SUPPORTED_MODES = [MODE_OCB2, MODE_XSALSA];

export default class CryptState {
    constructor(mode = MODE_OCB2) {
        this.modeName = mode;
        this.mode = createMode(mode);
        this.key = null;
        this.encryptIV = null;
        this.decryptIV = null;
        this.lastGoodTime = 0;
        this.good = 0;
        this.late = 0;
        this.lost = 0;
        this.resync = 0;
        this.remoteGood = 0;
        this.remoteLate = 0;
        this.remoteLost = 0;
        this.remoteResync = 0;
        this.remoteUdpPackets = 0;
        this.remoteTcpPackets = 0;
        this.remoteUdpPingAvg = 0;
        this.remoteUdpPingVar = 0;
        this.remoteTcpPingAvg = 0;
        this.remoteTcpPingVar = 0;
        this.decryptHistory = Buffer.alloc(IV_HISTORY_SIZE);
    }

    static supportedModes() {
        return SUPPORTED_MODES.slice();
    }

    setMode(mode) {
        this.modeName = mode;
        this.mode = createMode(mode);

        if (this.key) {
            this.mode.setKey(this.key);
        }
    }

    get nonceSize() {
        return this.mode.nonceSize();
    }

    get overhead() {
        return 1 + this.mode.overhead();
    }

    generateKey(mode = this.modeName) {
        this.setMode(mode);

        this.key = crypto.randomBytes(this.mode.keySize());
        this.mode.setKey(this.key);
        this.encryptIV = crypto.randomBytes(this.mode.nonceSize());
        this.decryptIV = crypto.randomBytes(this.mode.nonceSize());
    }

    setKey(mode, key, decryptIV, encryptIV) {
        this.setMode(mode);
        this.key = Buffer.from(key);
        this.mode.setKey(this.key);
        this.decryptIV = Buffer.from(decryptIV);
        this.encryptIV = Buffer.from(encryptIV);
    }

    getCryptSetup() {
        return {
            key: this.key,
            clientNonce: this.decryptIV,
            serverNonce: this.encryptIV
        };
    }

    handleCryptSetup(msg = {}) {
        if (!this.encryptIV || !this.decryptIV) {
            return null;
        }

        if (!msg.clientNonce || msg.clientNonce.length === 0) {
            return {
                clientNonce: Buffer.from(this.encryptIV)
            };
        }

        if (msg.clientNonce.length !== this.decryptIV.length) {
            throw new Error('cryptstate: invalid client nonce length');
        }

        this.resync += 1;
        this.decryptIV = Buffer.from(msg.clientNonce);
        return null;
    }

    markRemoteStats(ping = {}) {
        if (ping.good !== undefined && ping.good !== null) {
            this.remoteGood = ping.good;
        }
        if (ping.late !== undefined && ping.late !== null) {
            this.remoteLate = ping.late;
        }
        if (ping.lost !== undefined && ping.lost !== null) {
            this.remoteLost = ping.lost;
        }
        if (ping.resync !== undefined && ping.resync !== null) {
            this.remoteResync = ping.resync;
        }
        if (ping.udpPackets !== undefined && ping.udpPackets !== null) {
            this.remoteUdpPackets = ping.udpPackets;
        }
        if (ping.tcpPackets !== undefined && ping.tcpPackets !== null) {
            this.remoteTcpPackets = ping.tcpPackets;
        }
        if (ping.udpPingAvg !== undefined && ping.udpPingAvg !== null) {
            this.remoteUdpPingAvg = ping.udpPingAvg;
        }
        if (ping.udpPingVar !== undefined && ping.udpPingVar !== null) {
            this.remoteUdpPingVar = ping.udpPingVar;
        }
        if (ping.tcpPingAvg !== undefined && ping.tcpPingAvg !== null) {
            this.remoteTcpPingAvg = ping.tcpPingAvg;
        }
        if (ping.tcpPingVar !== undefined && ping.tcpPingVar !== null) {
            this.remoteTcpPingVar = ping.tcpPingVar;
        }
    }

    buildPingResponse(timestamp) {
        return {
            timestamp,
            good: this.good,
            late: this.late,
            lost: this.lost,
            resync: this.resync,
            udpPackets: this.remoteUdpPackets,
            tcpPackets: this.remoteTcpPackets,
            udpPingAvg: this.remoteUdpPingAvg,
            udpPingVar: this.remoteUdpPingVar,
            tcpPingAvg: this.remoteTcpPingAvg,
            tcpPingVar: this.remoteTcpPingVar
        };
    }

    shouldRequestResync() {
        return Date.now() / 1000 - this.lastGoodTime > 5;
    }

    incrementEncryptIV() {
        for (let i = 0; i < this.encryptIV.length; i += 1) {
            this.encryptIV[i] = (this.encryptIV[i] + 1) & 0xff;
            if (this.encryptIV[i] > 0) {
                break;
            }
        }
    }

    encrypt(plain) {
        const src = Buffer.from(plain);
        const dst = Buffer.alloc(this.overhead + src.length);

        this.incrementEncryptIV();
        dst[0] = this.encryptIV[0];
        this.mode.encrypt(dst.subarray(1), src, this.encryptIV);

        return dst;
    }

    decrypt(packet) {
        const src = Buffer.from(packet);
        const plainLength = src.length - this.overhead;

        if (src.length < this.overhead) {
            throw new Error('cryptstate: crypted length too short to decrypt');
        }

        const plain = Buffer.alloc(plainLength);
        const ivbyte = src[0];
        let restore = false;
        let lost = 0;
        let late = 0;

        const saveiv = Buffer.from(this.decryptIV);

        if (((this.decryptIV[0] + 1) & 0xff) === ivbyte) {
            if (ivbyte > this.decryptIV[0]) {
                this.decryptIV[0] = ivbyte;
            } else if (ivbyte < this.decryptIV[0]) {
                this.decryptIV[0] = ivbyte;
                for (let i = 1; i < this.decryptIV.length; i += 1) {
                    this.decryptIV[i] = (this.decryptIV[i] + 1) & 0xff;
                    if (this.decryptIV[i] > 0) {
                        break;
                    }
                }
            } else {
                throw new Error('cryptstate: invalid ivbyte');
            }
        } else {
            let diff = ivbyte - this.decryptIV[0];
            if (diff > 128) {
                diff -= 256;
            } else if (diff < -128) {
                diff += 256;
            }

            if (ivbyte < this.decryptIV[0] && diff > -30 && diff < 0) {
                late = 1;
                lost = -1;
                this.decryptIV[0] = ivbyte;
                restore = true;
            } else if (ivbyte > this.decryptIV[0] && diff > -30 && diff < 0) {
                late = 1;
                lost = -1;
                this.decryptIV[0] = ivbyte;
                for (let i = 1; i < this.decryptIV.length; i += 1) {
                    this.decryptIV[i] = (this.decryptIV[i] - 1) & 0xff;
                    if (this.decryptIV[i] > 0) {
                        break;
                    }
                }
                restore = true;
            } else if (ivbyte > this.decryptIV[0] && diff > 0) {
                lost = ivbyte - this.decryptIV[0] - 1;
                this.decryptIV[0] = ivbyte;
            } else if (ivbyte < this.decryptIV[0] && diff > 0) {
                lost = 256 - this.decryptIV[0] + ivbyte - 1;
                this.decryptIV[0] = ivbyte;
                for (let i = 1; i < this.decryptIV.length; i += 1) {
                    this.decryptIV[i] = (this.decryptIV[i] + 1) & 0xff;
                    if (this.decryptIV[i] > 0) {
                        break;
                    }
                }
            } else {
                throw new Error('cryptstate: no matching ivbyte');
            }

            if (this.decryptHistory[this.decryptIV[0]] === this.decryptIV[1]) {
                this.decryptIV = saveiv;
            }
        }

        const ok = this.mode.decrypt(plain, src.subarray(1), this.decryptIV);
        if (!ok) {
            this.decryptIV = saveiv;
            throw new Error('cryptstate: tag mismatch');
        }

        this.decryptHistory[this.decryptIV[0]] = this.decryptIV[1];

        if (restore) {
            this.decryptIV = saveiv;
        }

        this.good += 1;
        if (late > 0) {
            this.late += late;
        } else {
            this.late -= -late;
        }

        if (lost > 0) {
            this.lost = lost;
        } else {
            this.lost = -lost;
        }

        this.lastGoodTime = Math.floor(Date.now() / 1000);

        return plain;
    }
}
