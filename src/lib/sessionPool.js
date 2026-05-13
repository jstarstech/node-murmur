class SessionPool {
    constructor() {
        this.nextSessionId = 1;
        this.reclaimedSessions = [];
    }

    get() {
        if (this.reclaimedSessions.length > 0) {
            return this.reclaimedSessions.pop();
        }

        const sessionId = this.nextSessionId;
        this.nextSessionId += 1;

        if (sessionId === 0) {
            return this.get();
        }

        return sessionId;
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
