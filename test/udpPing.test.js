import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUdpPingReply, sendUdpPingReply } from '../src/lib/udpPing.js';

test('buildUdpPingReply encodes the ping payload', () => {
    const message = Buffer.alloc(12);
    message.writeDoubleBE(123.456, 4);

    const buffer = buildUdpPingReply(message, 17, 4096);

    assert.equal(buffer.length, 24);
    assert.equal(buffer.readUInt32BE(0), 0x00010204);
    assert.equal(buffer.readDoubleBE(4), 123.456);
    assert.equal(buffer.readInt32BE(12), 17);
    assert.equal(buffer.readInt32BE(16), 5);
    assert.equal(buffer.readInt32BE(20), 4096);
});

test('sendUdpPingReply logs send errors without throwing', () => {
    const logged = [];
    const message = Buffer.alloc(12);
    message.writeDoubleBE(5.5, 4);

    const serverUdp = {
        send(_buffer, _offset, _length, _port, _address, callback) {
            callback(new Error('send failed'));
        }
    };

    assert.doesNotThrow(() => {
        sendUdpPingReply({
            bandwidth: 1024,
            liveUserCount: 3,
            log: {
                trace(...args) {
                    logged.push(args);
                }
            },
            message,
            rinfo: {
                address: '127.0.0.1',
                port: 64738
            },
            serverUdp
        });
    });

    assert.equal(logged.length, 1);
    assert.equal(logged[0][1], 'Failed to send UDP ping reply');
    assert.equal(logged[0][0].address, '127.0.0.1');
    assert.equal(logged[0][0].port, 64738);
    assert.equal(logged[0][0].err.message, 'send failed');
});
