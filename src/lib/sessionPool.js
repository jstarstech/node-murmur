class SessionPool {
    constructor() {
        this.nextSessionId = 1;
        this.reclaimedSessions = [];
    }

    get() {
        return this.reclaimedSessions.pop() ?? this.nextSessionId++;
    }

    reclaim(sessionId) {
        const normalizedSessionId = Number(sessionId);
        if (!Number.isFinite(normalizedSessionId) || normalizedSessionId <= 0) {
            return;
        }

        this.reclaimedSessions.push(normalizedSessionId);
    }
}

export default SessionPool;
