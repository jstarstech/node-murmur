import protobufjs from 'protobufjs';

const map = {
    0: 'Version',
    1: 'UDPTunnel',
    2: 'Authenticate',
    3: 'Ping',
    4: 'Reject',
    5: 'ServerSync',
    6: 'ChannelRemove',
    7: 'ChannelState',
    8: 'UserRemove',
    9: 'UserState',
    10: 'BanList',
    11: 'TextMessage',
    12: 'PermissionDenied',
    13: 'ACL',
    14: 'QueryUsers',
    15: 'CryptSetup',
    16: 'ContextActionModify',
    17: 'ContextAction',
    18: 'UserList',
    19: 'VoiceTarget',
    20: 'PermissionQuery',
    21: 'CodecVersion',
    22: 'UserStats',
    23: 'RequestBlob',
    24: 'ServerConfig',
    25: 'SuggestConfig'
};

const root = await new Promise(resolve => {
    protobufjs.load('./lib/Mumble.proto', (err, root) => {
        if (err) {
            throw err;
        }

        resolve(root);
    });
});

export const buildPacket = (type, payload) => {
    let message = root.lookupType(`MumbleProto.${type}`).create(payload || {});
    return root.lookupType(`MumbleProto.${type}`).encode(message).finish();
};

export const decodePacket = (type_id, payload) => {
    let type = map[type_id];
    return root.lookupType(`MumbleProto.${type}`).decode(payload || {});
};

const idByName = {};
const nameById = {};

for (let k in map) {
    idByName[map[k]] = k * 1;
    nameById[k] = map[k];
}

export default {
    idByName,
    nameById,
    buildPacket,
    decodePacket
};
