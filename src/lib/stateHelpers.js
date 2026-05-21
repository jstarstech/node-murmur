function isActiveConnectionState(state) {
    return state === 'authenticated' || state === 'ready';
}

function isVersionNegotiatedState(state) {
    return state === 'version-sent' || state === 'version-received';
}

export { isActiveConnectionState, isVersionNegotiatedState };
