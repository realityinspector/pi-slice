/**
 * SessionManager — tracks active agent sessions across the system.
 */

export interface SessionEntry {
  agentId: string;
  sessionId: string;
  startedAt: Date;
}

export class SessionManager {
  private activeSessions = new Map<string, SessionEntry>();

  /**
   * Register a new active session.
   */
  register(agentId: string, sessionId: string): void {
    this.activeSessions.set(sessionId, {
      agentId,
      sessionId,
      startedAt: new Date(),
    });
  }

  /**
   * Remove a session from the active set.
   */
  unregister(sessionId: string): void {
    this.activeSessions.delete(sessionId);
  }

  /**
   * Get the active session ID for a given agent, if any.
   */
  getByAgent(agentId: string): string | undefined {
    for (const entry of this.activeSessions.values()) {
      if (entry.agentId === agentId) {
        return entry.sessionId;
      }
    }
    return undefined;
  }

  /**
   * Get all active sessions.
   */
  getAll(): SessionEntry[] {
    return Array.from(this.activeSessions.values());
  }
}
