import { computePermissions, PERMISSIONS, isGroupMember } from './Acl.js';
import { collectLinkedChannelIds, collectSubchannelIds } from './channelHelpers.js';

function collectVoiceTargetChannels(spec, channels) {
    const channelId = Number(spec.id);
    const channel = channels[channelId];

    if (!channel) {
        return new Set();
    }

    const result = new Set();

    if (!spec.links) {
        result.add(channelId);
    } else {
        for (const linkedId of collectLinkedChannelIds(channelId, channels)) {
            result.add(linkedId);
        }
    }

    if (spec.subChannels) {
        for (const childId of collectSubchannelIds(channelId, channels)) {
            result.add(childId);
        }
    }

    return result;
}

function collectVoiceTargetRecipients(
    sourceSession,
    sourceUser,
    targetDefinition,
    channels,
    aclState,
    Users,
    connectionsBySession
) {
    const directRecipients = new Map();
    const channelRecipients = new Map();

    for (const spec of targetDefinition.channels) {
        const channelIds = collectVoiceTargetChannels(spec, channels);
        if (channelIds.size === 0) {
            continue;
        }

        const onlyGroup = typeof spec.onlyGroup === 'string' && spec.onlyGroup.length > 0 ? spec.onlyGroup : '';

        for (const channelId of channelIds) {
            const targetChannel = channels[Number(channelId)];
            if (!targetChannel) {
                continue;
            }

            const whisperPermissions = computePermissions(Number(channelId), sourceUser, channels, aclState);
            if ((whisperPermissions & PERMISSIONS.Whisper) !== PERMISSIONS.Whisper) {
                continue;
            }

            for (const user of Object.values(Users.users)) {
                if (!user || user.session === undefined || user.session === null) {
                    continue;
                }

                if (user.session === sourceSession) {
                    continue;
                }

                if (Number(user.channelId) !== Number(channelId)) {
                    continue;
                }

                if (user.selfDeaf === true) {
                    continue;
                }

                if (
                    onlyGroup &&
                    !isGroupMember(onlyGroup, user, Number(channelId), Number(channelId), channels, aclState)
                ) {
                    continue;
                }

                const targetConnection = connectionsBySession.get(user.session);
                if (!targetConnection) {
                    continue;
                }

                channelRecipients.set(user.session, targetConnection);
            }
        }
    }

    for (const session of targetDefinition.sessions) {
        const targetSession = Number(session);
        if (!Number.isFinite(targetSession) || targetSession === sourceSession) {
            continue;
        }

        const targetConnection = connectionsBySession.get(targetSession);
        if (!targetConnection) {
            continue;
        }

        const targetUser = Object.values(Users.users).find(user => user && user.session === targetSession);
        if (targetUser?.selfDeaf === true) {
            continue;
        }

        if (!channelRecipients.has(targetSession)) {
            directRecipients.set(targetSession, targetConnection);
        }
    }

    channelRecipients.delete(sourceSession);
    directRecipients.delete(sourceSession);

    return { directRecipients, channelRecipients };
}

export { collectVoiceTargetChannels, collectVoiceTargetRecipients };
