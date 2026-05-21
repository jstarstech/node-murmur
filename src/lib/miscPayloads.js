function buildContextActionModifyPayload(action, entry, operation) {
    const payload = {
        action,
        operation
    };

    if (operation === 0 && entry) {
        payload.text = entry.text;
        payload.context = entry.context;
    }

    return payload;
}

function buildCodecVersionPayload(codecState) {
    return {
        alpha: Number(codecState.alpha || 0),
        beta: Number(codecState.beta || 0),
        preferAlpha: Boolean(codecState.preferAlpha),
        opus: Boolean(codecState.opus)
    };
}

export { buildContextActionModifyPayload, buildCodecVersionPayload };
