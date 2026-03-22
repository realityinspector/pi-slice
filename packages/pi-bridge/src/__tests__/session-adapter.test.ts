/**
 * Tests for SessionAdapter — verifies JSONL persistence,
 * session branching, and compaction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionAdapter, type SessionMetadata } from '../session-adapter.js';
import type { Message } from '../provider.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Setup ───────────────────────────────────────────────────────────────────

let sessionDir: string;
let adapter: SessionAdapter;

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-adapter-test-'));
  adapter = new SessionAdapter(sessionDir);
});

afterEach(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function sampleMessages(): Message[] {
  return [
    { role: 'system', content: 'You are a test agent.' },
    { role: 'user', content: 'Hello!' },
    { role: 'assistant', content: 'Hi there!' },
  ];
}

function sampleMetadata(overrides?: Partial<SessionMetadata>): SessionMetadata {
  return {
    sessionId: 'test-session-1',
    agentId: 'agent-1',
    model: 'anthropic/claude-sonnet-4',
    startedAt: '2026-03-22T00:00:00.000Z',
    status: 'active',
    tokenCount: 100,
    messageCount: 3,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SessionAdapter', () => {
  describe('save and load', () => {
    it('should save and load messages + metadata', () => {
      const messages = sampleMessages();
      const metadata = sampleMetadata();

      adapter.save('test-session-1', messages, metadata);

      const loaded = adapter.load('test-session-1');
      expect(loaded).not.toBeNull();
      expect(loaded!.messages).toEqual(messages);
      expect(loaded!.metadata).toEqual(metadata);
    });

    it('should persist messages as JSONL format', () => {
      const messages = sampleMessages();
      adapter.save('test-session-1', messages, sampleMetadata());

      const raw = fs.readFileSync(path.join(sessionDir, 'test-session-1.jsonl'), 'utf-8');
      const lines = raw.trim().split('\n');
      expect(lines.length).toBe(3);
      expect(JSON.parse(lines[0])).toEqual(messages[0]);
      expect(JSON.parse(lines[1])).toEqual(messages[1]);
      expect(JSON.parse(lines[2])).toEqual(messages[2]);
    });

    it('should return null for non-existent session', () => {
      expect(adapter.load('non-existent')).toBeNull();
    });
  });

  describe('appendMessage', () => {
    it('should append a message to existing JSONL', () => {
      adapter.save('test-session-1', sampleMessages(), sampleMetadata());

      adapter.appendMessage('test-session-1', { role: 'user', content: 'Follow-up' });

      const loaded = adapter.load('test-session-1');
      expect(loaded!.messages.length).toBe(4);
      expect(loaded!.messages[3].content).toBe('Follow-up');
    });
  });

  describe('updateMetadata', () => {
    it('should update metadata without touching messages', () => {
      adapter.save('test-session-1', sampleMessages(), sampleMetadata());

      adapter.updateMetadata('test-session-1', sampleMetadata({ tokenCount: 500 }));

      const loaded = adapter.load('test-session-1');
      expect(loaded!.metadata.tokenCount).toBe(500);
      expect(loaded!.messages.length).toBe(3); // unchanged
    });
  });

  describe('list', () => {
    it('should list all sessions', () => {
      adapter.save('session-a', sampleMessages(), sampleMetadata({ sessionId: 'session-a' }));
      adapter.save('session-b', sampleMessages(), sampleMetadata({ sessionId: 'session-b' }));

      const list = adapter.list();
      expect(list.length).toBe(2);
      const ids = list.map((m) => m.sessionId).sort();
      expect(ids).toEqual(['session-a', 'session-b']);
    });

    it('should return empty array for no sessions', () => {
      expect(adapter.list()).toEqual([]);
    });
  });

  describe('delete', () => {
    it('should delete session files', () => {
      adapter.save('test-session-1', sampleMessages(), sampleMetadata());
      adapter.delete('test-session-1');

      expect(adapter.load('test-session-1')).toBeNull();
      expect(adapter.exists('test-session-1')).toBe(false);
    });
  });

  describe('exists', () => {
    it('should check if session exists', () => {
      expect(adapter.exists('test-session-1')).toBe(false);
      adapter.save('test-session-1', sampleMessages(), sampleMetadata());
      expect(adapter.exists('test-session-1')).toBe(true);
    });
  });

  describe('branch', () => {
    it('should fork a session at a given message index', () => {
      const messages: Message[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'Message 1' },
        { role: 'assistant', content: 'Response 1' },
        { role: 'user', content: 'Message 2' },
        { role: 'assistant', content: 'Response 2' },
      ];
      adapter.save('parent', messages, sampleMetadata({ sessionId: 'parent', messageCount: 5 }));

      // Branch after the first exchange (index 2 = system + user1 + assistant1)
      const branched = adapter.branch('parent', 2, 'child');
      expect(branched).not.toBeNull();
      expect(branched!.messages.length).toBe(3);
      expect(branched!.messages[0].role).toBe('system');
      expect(branched!.messages[2].content).toBe('Response 1');
      expect(branched!.metadata.parentSessionId).toBe('parent');
      expect(branched!.metadata.branchPointIndex).toBe(2);

      // Verify it was persisted
      const loaded = adapter.load('child');
      expect(loaded!.messages.length).toBe(3);
    });

    it('should throw for out-of-range branch point', () => {
      adapter.save('parent', sampleMessages(), sampleMetadata({ sessionId: 'parent' }));
      expect(() => adapter.branch('parent', 10, 'child')).toThrow('out of range');
    });

    it('should return null for non-existent source', () => {
      expect(adapter.branch('non-existent', 0, 'child')).toBeNull();
    });
  });

  describe('compact', () => {
    it('should compact old messages and keep recent ones', async () => {
      // Create a session with many messages
      const messages: Message[] = [
        { role: 'system', content: 'System prompt' },
      ];
      for (let i = 0; i < 20; i++) {
        messages.push({ role: 'user', content: `User message ${i}` });
        messages.push({ role: 'assistant', content: `Response ${i}` });
      }

      adapter.save(
        'long-session',
        messages,
        sampleMetadata({ sessionId: 'long-session', messageCount: messages.length }),
      );

      // Compact keeping last 6 messages
      const result = await adapter.compact('long-session', { keepRecent: 6 });
      expect(result).not.toBeNull();

      const loaded = adapter.load('long-session');
      // Should have: system prompt + summary + 6 recent = 8
      expect(loaded!.messages.length).toBe(8);
      expect(loaded!.messages[0].role).toBe('system');
      expect(loaded!.messages[1].role).toBe('assistant'); // summary
      expect(loaded!.messages[1].content).toContain('compacted');
      expect(loaded!.metadata.compactionCount).toBe(1);
      expect(loaded!.metadata.lastCompactedAt).toBeTruthy();
    });

    it('should use custom summarizer when provided', async () => {
      const messages: Message[] = [
        { role: 'system', content: 'System prompt' },
      ];
      for (let i = 0; i < 20; i++) {
        messages.push({ role: 'user', content: `User message ${i}` });
        messages.push({ role: 'assistant', content: `Response ${i}` });
      }

      adapter.save(
        'custom-compact',
        messages,
        sampleMetadata({ sessionId: 'custom-compact', messageCount: messages.length }),
      );

      const result = await adapter.compact('custom-compact', {
        keepRecent: 4,
        summarizer: async (msgs) => `Custom summary of ${msgs.length} messages`,
      });

      expect(result).not.toBeNull();
      const loaded = adapter.load('custom-compact');
      expect(loaded!.messages[1].content).toBe('Custom summary of 36 messages');
    });

    it('should not compact when too few messages', async () => {
      adapter.save(
        'short-session',
        sampleMessages(),
        sampleMetadata({ sessionId: 'short-session' }),
      );

      const result = await adapter.compact('short-session', { keepRecent: 10 });
      expect(result).not.toBeNull();

      // No change
      const loaded = adapter.load('short-session');
      expect(loaded!.messages.length).toBe(3);
    });

    it('should return null for non-existent session', async () => {
      const result = await adapter.compact('non-existent');
      expect(result).toBeNull();
    });
  });
});
