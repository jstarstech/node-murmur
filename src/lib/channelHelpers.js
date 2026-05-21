import crypto from 'crypto';
import Channels from '../models/channels.js';
import ChannelInfo from '../models/channel_info.js';
import { sequelize } from '../models/index.js';

const DEFAULT_CHANNEL_NAME_PATTERN = '[ \\-=\\w#\\[\\]\\{\\}\\(\\)@\\|\\.]+';

async function getChannels(server_id) {
    const channels = {};

    const dbChannels = await Channels.findAll({
        where: {
            server_id
        },
        raw: true
    }).catch(err => {
        return [];
    });

    const channelInfos = await ChannelInfo.findAll({
        where: {
            server_id
        },
        raw: true
    }).catch(err => {
        return [];
    });

    const infosByChannel = new Map();
    for (const channelInfo of channelInfos) {
        const channelId = Number(channelInfo.channel_id);
        if (!infosByChannel.has(channelId)) {
            infosByChannel.set(channelId, []);
        }

        infosByChannel.get(channelId).push(channelInfo);
    }

    for (const dbChannel of dbChannels) {
        const channelId = Number(dbChannel.channel_id);
        channels[channelId] = {
            ...dbChannel,
            channel_id: channelId
        };

        for (const channelInfo of infosByChannel.get(channelId) || []) {
            if (Number(channelInfo.key) === 0) {
                channels[channelId].description = channelInfo.value == null ? '' : String(channelInfo.value);
            }

            if (Number(channelInfo.key) === 1) {
                channels[channelId].position = channelInfo.value;
            }
        }
    }

    if (!channels[0]) {
        channels[0] = {
            channel_id: 0,
            parent_id: null,
            name: 'Root',
            description: '',
            position: '0',
            links: new Set()
        };
    }

    for (const channel of Object.values(channels)) {
        if (!channel.description) {
            channel.description = '';
        }

        if (!(channel.links instanceof Set)) {
            channel.links = new Set();
        }
    }

    return channels;
}

async function loadChannelLinks(serverId, channels) {
    const [rows] = await sequelize.query(
        `SELECT channel_id, link_id
         FROM channel_links
         WHERE server_id = ${Number(serverId)}`
    );

    for (const row of rows || []) {
        const channelId = Number(row.channel_id);
        const linkId = Number(row.link_id);
        const channel = channels[channelId];
        const linkedChannel = channels[linkId];

        if (!channel || !linkedChannel) {
            continue;
        }

        if (!(channel.links instanceof Set)) {
            channel.links = new Set();
        }

        if (!(linkedChannel.links instanceof Set)) {
            linkedChannel.links = new Set();
        }

        channel.links.add(linkId);
        linkedChannel.links.add(channelId);
    }
}

function buildChannelStatePayload(channel, clientVersion = 0, { includeDescription = false } = {}) {
    const description = channel.description || '';
    const descriptionBuffer = Buffer.from(description);
    const shouldSendHash = !includeDescription && descriptionBuffer.length >= 128 && (clientVersion || 0) >= 0x10202;
    const position = Number.isFinite(Number(channel.position)) ? Number(channel.position) : 0;
    const links = Array.isArray(channel.links) ? channel.links : channel.links instanceof Set ? [...channel.links] : [];

    return {
        channelId: channel.channel_id,
        parent: channel.parent_id,
        name: channel.name,
        links: links
            .map(link => Number(link))
            .filter(link => Number.isFinite(link))
            .sort((left, right) => left - right),
        linksAdd: [],
        linksRemove: [],
        temporary: Boolean(channel.temporary),
        position,
        description: shouldSendHash ? '' : description,
        descriptionHash: shouldSendHash ? crypto.createHash('sha1').update(descriptionBuffer).digest() : null
    };
}

async function setChannelDescriptionValue(serverId, channelId, description, transaction) {
    const channelDescription = typeof description === 'string' ? description : '';

    await sequelize.query(
        `DELETE FROM channel_info
         WHERE server_id = ${Number(serverId)}
           AND channel_id = ${Number(channelId)}
           AND key = 0`,
        { transaction }
    );

    if (channelDescription.length === 0) {
        return null;
    }

    await sequelize.query(
        `INSERT INTO channel_info (server_id, channel_id, key, value)
         VALUES (
            ${Number(serverId)},
            ${Number(channelId)},
            0,
            ${sequelize.escape(channelDescription)}
         )`,
        { transaction }
    );

    return channelDescription;
}

function sendChannelState(connection, channel) {
    connection.sendMessage('ChannelState', buildChannelStatePayload(channel, connection.clientVersion));
}

function sendChannelTree(connection, channels, channel) {
    if (!channel) {
        return;
    }

    sendChannelState(connection, channel);

    const children = Object.values(channels)
        .filter(child => child.parent_id === channel.channel_id)
        .sort((left, right) => {
            const leftPos = Number.isFinite(Number(left.position)) ? Number(left.position) : 0;
            const rightPos = Number.isFinite(Number(right.position)) ? Number(right.position) : 0;
            if (leftPos !== rightPos) {
                return leftPos - rightPos;
            }

            return left.channel_id - right.channel_id;
        });

    for (const child of children) {
        sendChannelTree(connection, channels, child);
    }
}

function buildChannelNameValidator(pattern) {
    const source = typeof pattern === 'string' && pattern.length > 0 ? pattern : DEFAULT_CHANNEL_NAME_PATTERN;

    try {
        return new RegExp(`^(?:${source})$`);
    } catch {
        return new RegExp(`^(?:${DEFAULT_CHANNEL_NAME_PATTERN})$`);
    }
}

function collectLinkedChannelIds(channelId, channels) {
    const seen = new Set();
    const stack = [Number(channelId)];

    while (stack.length > 0) {
        const currentId = stack.pop();
        const currentChannel = channels[Number(currentId)];

        if (!currentChannel || !(currentChannel.links instanceof Set)) {
            continue;
        }

        for (const linkedId of currentChannel.links) {
            const nextId = Number(linkedId);
            if (!Number.isFinite(nextId) || seen.has(nextId)) {
                continue;
            }

            seen.add(nextId);
            stack.push(nextId);
        }
    }

    return seen;
}

function collectSubchannelIds(channelId, channels) {
    const seen = new Set();
    const stack = [Number(channelId)];

    while (stack.length > 0) {
        const currentId = stack.pop();

        for (const channel of Object.values(channels)) {
            if (Number(channel.parent_id) !== Number(currentId)) {
                continue;
            }

            const childId = Number(channel.channel_id);
            if (!Number.isFinite(childId) || seen.has(childId)) {
                continue;
            }

            seen.add(childId);
            stack.push(childId);
        }
    }

    return seen;
}

export {
    getChannels,
    loadChannelLinks,
    buildChannelStatePayload,
    setChannelDescriptionValue,
    sendChannelState,
    sendChannelTree,
    buildChannelNameValidator,
    collectLinkedChannelIds,
    collectSubchannelIds
};
export default DEFAULT_CHANNEL_NAME_PATTERN;
