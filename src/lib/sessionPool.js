class SessionPool {
    constructor(maxUsers = 100) {
        this.availableSessions = [];
        this.configure(maxUsers);
    }

    configure(maxUsers = 100) {
        const normalizedMaxUsers = Number(maxUsers) || 100;
        const maxSessionId = Math.max(1, normalizedMaxUsers * 2 - 1);
        this.availableSessions = [];

        for (let sessionId = 1; sessionId <= maxSessionId; sessionId += 1) {
            this.availableSessions.push(sessionId);
        }
    }

    get() {
        const sessionId = this.availableSessions.shift();
        if (sessionId === undefined) {
            throw new Error('Session ID pool exhausted');
        }

        return sessionId;
    }

    reclaim(sessionId) {
        const normalizedSessionId = Number(sessionId);
        if (!Number.isFinite(normalizedSessionId) || normalizedSessionId <= 0) {
            return;
        }

        this.availableSessions.push(normalizedSessionId);
    }
}

export default SessionPool;
