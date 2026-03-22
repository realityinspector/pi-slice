/**
 * SessionAdapter — persists agent sessions to disk as JSONL + metadata JSON.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Message } from './provider.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SessionMetadata {
  sessionId: string;
  agentId: string;
  model: string;
  startedAt: string;
  lastMessageAt?: string;
  status: 'active' | 'paused' | 'closed';
  tokenCount: number;
  messageCount: number;
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

  // ── Helpers ─────────────────────────────────────────────────────────────

  private messagesPath(sessionId: string): string {
    return path.join(this.sessionDir, `${sessionId}.jsonl`);
  }

  private metaPath(sessionId: string): string {
    return path.join(this.sessionDir, `${sessionId}.meta.json`);
  }
}
