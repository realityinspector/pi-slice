/**
 * SessionManager — tracks active agent sessions across the system.
 *
 * Bridges the pi-bridge AgentSpawner with the orchestrator's dispatch system.
 * Tracks which agents have active sessions, their associated tasks and worktrees,
 * and provides lifecycle hooks for session events.
 */

import type { AgentSession, SessionStatus, SpawnMode } from '@slice/pi-bridge';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SessionEntry {
  /** Agent entity ID */
  agentId: string;
  /** Session ID from AgentSpawner */
  sessionId: string;
  /** Associated task ID (if any) */
  taskId?: string;
  /** Associated worktree ID (if any) */
  worktreeId?: string;
  /** Spawn mode used */
  mode?: SpawnMode;
  /** Session status (mirrors AgentSession.status) */
  status: SessionStatus;
  /** When the session was registered */
  startedAt: Date;
  /** Last activity timestamp */
  lastActivityAt: Date;
  /** Total tokens consumed (updated periodically) */
  tokenCount: number;
}

export interface SessionManagerConfig {
  /** Callback when a session is registered */
  onSessionStart?: (entry: SessionEntry) => void;
  /** Callback when a session ends */
  onSessionEnd?: (entry: SessionEntry) => void;
  /** Callback when session activity is updated */
  onSessionActivity?: (entry: SessionEntry) => void;
}

// ── Manager ─────────────────────────────────────────────────────────────────

export class SessionManager {
  private activeSessions = new Map<string, SessionEntry>();
  private config: SessionManagerConfig;

  constructor(config: SessionManagerConfig = {}) {
    this.config = config;
  }

  /**
   * Register a new active session.
   */
  register(
    agentId: string,
    sessionId: string,
    options?: { taskId?: string; worktreeId?: string; mode?: SpawnMode },
  ): SessionEntry {
    const now = new Date();
    const entry: SessionEntry = {
      agentId,
      sessionId,
      taskId: options?.taskId,
      worktreeId: options?.worktreeId,
      mode: options?.mode,
      status: 'active',
      startedAt: now,
      lastActivityAt: now,
      tokenCount: 0,
    };

    this.activeSessions.set(sessionId, entry);
    this.config.onSessionStart?.(entry);
    return entry;
  }

  /**
   * Remove a session from the active set.
   */
  unregister(sessionId: string): void {
    const entry = this.activeSessions.get(sessionId);
    if (entry) {
      entry.status = 'closed';
      this.config.onSessionEnd?.(entry);
    }
    this.activeSessions.delete(sessionId);
  }

  /**
   * Update session tracking from a live AgentSession.
   * Call this periodically or after significant events.
   */
  updateFromSession(session: AgentSession): void {
    const entry = this.activeSessions.get(session.id);
    if (!entry) return;

    entry.status = session.status;
    entry.tokenCount = session.tokenCount;
    entry.lastActivityAt = session.lastMessageAt ?? entry.lastActivityAt;
    this.config.onSessionActivity?.(entry);
  }

  /**
   * Get entry by session ID.
   */
  get(sessionId: string): SessionEntry | undefined {
    return this.activeSessions.get(sessionId);
  }

  /**
   * Get the active session ID for a given agent, if any.
   */
  getByAgent(agentId: string): string | undefined {
    for (const entry of this.activeSessions.values()) {
      if (entry.agentId === agentId && entry.status === 'active') {
        return entry.sessionId;
      }
    }
    return undefined;
  }

  /**
   * Get the session for a given task, if any.
   */
  getByTask(taskId: string): SessionEntry | undefined {
    for (const entry of this.activeSessions.values()) {
      if (entry.taskId === taskId) {
        return entry;
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

  /**
   * Get count of active sessions.
   */
  getActiveCount(): number {
    let count = 0;
    for (const entry of this.activeSessions.values()) {
      if (entry.status === 'active') count++;
    }
    return count;
  }

  /**
   * Clear all sessions (e.g. on system shutdown).
   */
  clear(): void {
    for (const entry of this.activeSessions.values()) {
      entry.status = 'closed';
      this.config.onSessionEnd?.(entry);
    }
    this.activeSessions.clear();
  }
}
