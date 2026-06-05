import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoiceSender } from '../src/lib/voiceSender.js';
import { PERMISSIONS } from '../src/lib/Acl.js';

const log = { error() {}, info() {}, warn() {}, debug() {} };

// Normal speech frame: header byte = (type 0 << 5) | target 0 => 0x00.
const SPEECH = Buffer.from([0x00, 0x01, 0x02]);

function makeConnection() {
    const sent = [];
    return {
        sent,
        voiceTargets: new Map(),
        // No cryptState/udpaddr, so sendVoicePacket falls back to the TCP UDPTunnel.
        sendMessage(type, payload) {
            sent.push({ type, payload });
        }
    };
}

function setup({ aclRows } = {}) {
    const channels = { 1: { channel_id: 1, inheritacl: 1 } };
    const aclState = {
        aclRowsByChannel: new Map(aclRows ? [[1, aclRows]] : []),
        groupsByChannel: new Map()
    };

    const speaker = { session: 10, userId: 5, channelId: 1, selfDeaf: false };
    const listener = { session: 20, userId: 6, channelId: 1, selfDeaf: false };
    const elsewhere = { session: 30, userId: 7, channelId: 2, selfDeaf: false };

    const Users = {
        users: { speaker, listener, elsewhere },
        sessionToChannels: { 10: 1, 20: 1, 30: 2 }
    };

    const conns = {
        10: makeConnection(),
        20: makeConnection(),
        30: makeConnection()
    };
    const connectionsBySession = new Map(Object.entries(conns).map(([s, c]) => [Number(s), c]));

    const sender = createVoiceSender({
        channels,
        aclState,
        Users,
        connectionsBySession,
        udpAddrToConnection: new Map(),
        getUdpAddrKey: rinfo => `${rinfo.address}:${rinfo.port}`,
        findUserBySession: session => Object.values(Users.users).find(u => u.session === session),
        log
    });

    return { sender, speaker, listener, elsewhere, conns };
}

test('relays normal speech to others in the channel when the speaker has Speak', () => {
    const { sender, conns } = setup();
    sender.broadcastVoicePacket(SPEECH, 10);
    assert.equal(conns[20].sent.length, 1);
    assert.equal(conns[20].sent[0].type, 'UDPTunnel');
});

test('drops normal speech when the speaker is denied Speak', () => {
    const { sender, conns } = setup({
        aclRows: [
            {
                channelId: 1,
                userId: 5,
                groupName: null,
                applyHere: true,
                applySub: false,
                grant: 0,
                deny: PERMISSIONS.Speak
            }
        ]
    });
    sender.broadcastVoicePacket(SPEECH, 10);
    assert.equal(conns[20].sent.length, 0);
});

test('does not echo normal speech back to the speaker', () => {
    const { sender, conns } = setup();
    sender.broadcastVoicePacket(SPEECH, 10);
    assert.equal(conns[10].sent.length, 0);
});

test('skips self-deafened recipients', () => {
    const { sender, listener, conns } = setup();
    listener.selfDeaf = true;
    sender.broadcastVoicePacket(SPEECH, 10);
    assert.equal(conns[20].sent.length, 0);
});

test('does not deliver normal speech to users in other channels', () => {
    const { sender, conns } = setup();
    sender.broadcastVoicePacket(SPEECH, 10);
    assert.equal(conns[30].sent.length, 0);
});
