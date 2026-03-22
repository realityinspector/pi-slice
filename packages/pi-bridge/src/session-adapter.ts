/**
 * SessionAdapter — persists agent sessions to disk as JSONL + metadata JSON.
 *
 * Features:
 * - JSONL message persistence for git-friendly session history
 * - Rich metadata for Quarry entity mapping
 * - Session branching (fork from any point in conversation)
 * - Session compaction for long-running agents
 * - Append-only JSONL writes for incremental updates
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Message } from './provider.js';
import type { SpawnMode, SessionLifecyclePhase } from './spawner.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SessionMetadata {
  /** Unique session identifier */
  sessionId: string;
  /** Quarry entity ID for the agent */
  agentId: string;
  /** OpenRouter model ID */
  model: string;
  /** ISO timestamp when session started */
  startedAt: string;
  /** ISO timestamp of last message */
  lastMessageAt?: string;
  /** Session status */
  status: 'active' | 'paused' | 'closed';
  /** Total tokens consumed */
  tokenCount: number;
  /** Total number of messages */
  messageCount: number;
  /** Spawn mode used */
  mode?: SpawnMode;
  /** Current lifecycle phase */
  phase?: SessionLifecyclePhase;
  /** Parent session ID (set when this session was branched) */
  parentSessionId?: string;
  /** Branch point: message index in parent session where this was forked */
  branchPointIndex?: number;
  /** Number of compactions performed */
  compactionCount?: number;
  /** ISO timestamp of last compaction */
  lastCompactedAt?: string;
  /** Original message count before compaction (cumulative) */
  originalMessageCount?: number;
}

/** Options for session compaction */
export interface CompactionOptions {
  /** Keep the last N messages uncompacted (default: 10) */
  keepRecent?: number;
  /** System prompt to use for the compaction summary (default: auto-generate) */
  summarySystemPrompt?: string;
  /** Custom summarizer function. If not provided, messages are simply truncated. */
  summarizer?: (messages: Message[]) => Promise<string>;
}

// ── Adapter ─────────────────────────────────────────────────────────────────

export class SessionAdapter {
  private sessionDir: string;

  constructor(sessionDir: string) {
    this.sessionDir = sessionDir;
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  /**
   * Save messages as JSONL and metadata as JSON.
   */
  save(sessionId: string, messages: Message[], metadata: SessionMetadata): void {
    const messagesPath = this.messagesPath(sessionId);
    const metaPath = this.metaPath(sessionId);

    // Write messages as JSONL (one JSON object per line)
    const jsonl = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
    fs.writeFileSync(messagesPath, jsonl, 'utf-8');

    // Write metadata as formatted JSON
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + '\n', 'utf-8');
  }

  /**
   * Append a single message to an existing session's JSONL file.
   * More efficient than rewriting the entire file for incremental updates.
   */
  appendMessage(sessionId: string, message: Message): void {
    const messagesPath = this.messagesPath(sessionId);
    fs.appendFileSync(messagesPath, JSON.stringify(message) + '\n', 'utf-8');
  }

  /**
   * Update only the metadata file without touching messages.
   */
  updateMetadata(sessionId: string, metadata: SessionMetadata): void {
    const metaPath = this.metaPath(sessionId);
    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2) + '\n', 'utf-8');
  }

  /**
   * Load a session's messages and metadata from disk.
   * Returns null if the session files don't exist.
   */
  load(sessionId: string): { messages: Message[]; metadata: SessionMetadata } | null {
    const messagesPath = this.messagesPath(sessionId);
    const metaPath = this.metaPath(sessionId);

    if (!fs.existsSync(messagesPath) || !fs.existsSync(metaPath)) {
      return null;
    }

    // Parse JSONL
    const rawLines = fs.readFileSync(messagesPath, 'utf-8').trim().split('\n');
    const messages: Message[] = rawLines
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Message);

    // Parse metadata
    const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SessionMetadata;

    return { messages, metadata };
  }

  /**
   * List all session metadata files in the session directory.
   */
  list(): SessionMetadata[] {
    if (!fs.existsSync(this.sessionDir)) {
      return [];
    }

    const files = fs.readdirSync(this.sessionDir);
    const metaFiles = files.filter((f) => f.endsWith('.meta.json'));

    const results: SessionMetadata[] = [];
    for (const file of metaFiles) {
      try {
        const raw = fs.readFileSync(path.join(this.sessionDir, file), 'utf-8');
        results.push(JSON.parse(raw) as SessionMetadata);
      } catch {
        // Skip corrupt metadata files
      }
    }

    return results;
  }

  /**
   * Delete a session's files from disk.
   */
  delete(sessionId: string): void {
    const messagesPath = this.messagesPath(sessionId);
    const metaPath = this.metaPath(sessionId);

    if (fs.existsSync(messagesPath)) {
      fs.unlinkSync(messagesPath);
    }
    if (fs.existsSync(metaPath)) {
      fs.unlinkSync(metaPath);
    }
  }

  /**
   * Branch (fork) a session at a specific message index.
   * Creates a new session that shares history up to branchPoint.
   *
   * @param sourceSessionId - The session to branch from
   * @param branchPoint - Message index to fork at (inclusive; messages 0..branchPoint are copied)
   * @param newSessionId - ID for the new branched session
   * @param metadataOverrides - Override fields in the new session's metadata
   * @returns The new session's metadata, or null if source not found
   */
  branch(
    sourceSessionId: string,
    branchPoint: number,
    newSessionId: string,
    metadataOverrides?: Partial<SessionMetadata>,
  ): { messages: Message[]; metadata: SessionMetadata } | null {
    const source = this.load(sourceSessionId);
    if (!source) return null;

    if (branchPoint < 0 || branchPoint >= source.messages.length) {
      throw new Error(
        `Branch point ${branchPoint} out of range [0, ${source.messages.length - 1}]`,
      );
    }

    // Copy messages up to and including branchPoint
    const branchedMessages = source.messages.slice(0, branchPoint + 1);

    const newMetadata: SessionMetadata = {
      ...source.metadata,
      sessionId: newSessionId,
      startedAt: new Date().toISOString(),
      lastMessageAt: undefined,
      status: 'active',
      messageCount: branchedMessages.length,
      parentSessionId: sourceSessionId,
      branchPointIndex: branchPoint,
      compactionCount: 0,
      lastCompactedAt: undefined,
      ...metadataOverrides,
    };

    this.save(newSessionId, branchedMessages, newMetadata);

    return { messages: branchedMessages, metadata: newMetadata };
  }

  /**
   * Compact a session's message history to reduce token usage.
   *
   * Strategy:
   * 1. Keep the system prompt (first message)
   * 2. Summarize old messages into a single assistant message
   * 3. Keep the most recent N messages intact
   *
   * @param sessionId - Session to compact
   * @param options - Compaction options
   * @returns Updated metadata, or null if session not found
   */
  async compact(
    sessionId: string,
    options: CompactionOptions = {},
  ): Promise<SessionMetadata | null> {
    const session = this.load(sessionId);
    if (!session) return null;

    const { messages, metadata } = session;
    const keepRecent = options.keepRecent ?? 10;

    // Need at least system prompt + keepRecent + some messages to compact
    if (messages.length <= keepRecent + 2) {
      // Nothing to compact
      return metadata;
    }

    // Split messages: system prompt, compactable region, recent messages
    const systemPrompt = messages[0]; // always system
    const recentStart = Math.max(1, messages.length - keepRecent);
    const toCompact = messages.slice(1, recentStart);
    const recentMessages = messages.slice(recentStart);

    let summaryContent: string;

    if (options.summarizer) {
      summaryContent = await options.summarizer(toCompact);
    } else {
      // Default: create a structured summary of compacted messages
      const userMsgs = toCompact.filter(m => m.role === 'user').length;
      const assistantMsgs = toCompact.filter(m => m.role === 'assistant').length;
      summaryContent = [
        `[Session compacted: ${toCompact.length} messages summarized (${userMsgs} user, ${assistantMsgs} assistant)]`,
        '',
        'Key conversation points:',
        ...toCompact
          .filter(m => m.role === 'user')
          .slice(0, 5)
          .map(m => `- User: ${m.content.slice(0, 200)}${m.content.length > 200 ? '...' : ''}`),
        '',
        'Last assistant response before compaction:',
        toCompact
          .filter(m => m.role === 'assistant')
          .pop()?.content.slice(0, 500) ?? '(none)',
      ].join('\n');
    }

    const compactedMessages: Message[] = [
      systemPrompt,
      { role: 'assistant', content: summaryContent },
      ...recentMessages,
    ];

    // Update metadata
    const updatedMetadata: SessionMetadata = {
      ...metadata,
      messageCount: compactedMessages.length,
      compactionCount: (metadata.compactionCount ?? 0) + 1,
      lastCompactedAt: new Date().toISOString(),
      originalMessageCount: (metadata.originalMessageCount ?? messages.length) + toCompact.length,
    };

    this.save(sessionId, compactedMessages, updatedMetadata);

    return updatedMetadata;
  }

  /**
   * Check if a session exists on disk.
   */
  exists(sessionId: string): boolean {
    return fs.existsSync(this.messagesPath(sessionId)) && fs.existsSync(this.metaPath(sessionId));
  }

  /**
   * Get the session directory path.
   */
  getSessionDir(): string {
    return this.sessionDir;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private messagesPath(sessionId: string): string {
    return path.join(this.sessionDir, `${sessionId}.jsonl`);
  }

  private metaPath(sessionId: string): string {
    return path.join(this.sessionDir, `${sessionId}.meta.json`);
  }
}
