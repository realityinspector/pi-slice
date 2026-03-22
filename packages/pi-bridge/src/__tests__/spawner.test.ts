/**
 * Tests for AgentSpawner — verifies SDK-mode session lifecycle,
 * persistence via SessionAdapter, and resume functionality.
 *
 * Uses a mock HTTP server to avoid real OpenRouter API calls.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SlicePiProvider } from '../provider.js';
import { AgentSpawner, type SpawnOptions } from '../spawner.js';
import { SessionAdapter } from '../session-adapter.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Mock Server ────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let baseUrl: string;

function mockHandler(req: IncomingMessage, res: ServerResponse) {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString()));
  req.on('end', () => {
    const url = req.url ?? '';

    if (url === '/chat/completions' && req.method === 'POST') {
      const parsed = JSON.parse(body);

      if (parsed.stream) {
        // Streaming response
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'x-ratelimit-remaining': '42',
          'x-openrouter-cost': '0.000123',
        });

        res.write('data: {"id":"1","choices":[{"delta":{"content":"Hello"}}]}\n\n');
        res.write('data: {"id":"1","choices":[{"delta":{"content":" from"}}]}\n\n');
        res.write('data: {"id":"1","choices":[{"delta":{"content":" mock"}}]}\n\n');
        res.write(
          'data: {"id":"1","choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n',
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // Non-streaming response
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-ratelimit-remaining': '42',
        'x-openrouter-cost': '0.000123',
      });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock-1',
          choices: [{ message: { content: 'Hello from mock agent!' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });
}

// ── Test setup ──────────────────────────────────────────────────────────────

let provider: SlicePiProvider;
let sessionDir: string;

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      server = createServer(mockHandler);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        provider = new SlicePiProvider({ openrouterApiKey: 'test-key', baseUrl });
        resolve();
      });
    }),
);

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    }),
);

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawner-test-'));
});

afterEach(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function defaultSpawnOptions(overrides?: Partial<SpawnOptions>): SpawnOptions {
  return {
    agentId: 'agent-test-1',
    model: 'anthropic/claude-sonnet-4',
    systemPrompt: 'You are a helpful test agent.',
    sessionDir,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AgentSpawner', () => {
  describe('SDK mode', () => {
    it('should spawn an agent and send a prompt', async () => {
      const spawner = new AgentSpawner(provider);
      const session = await spawner.spawn(defaultSpawnOptions());

      expect(session.id).toBeTruthy();
      expect(session.agentId).toBe('agent-test-1');
      expect(session.model).toBe('anthropic/claude-sonnet-4');
      expect(session.mode).toBe('sdk');
      expect(session.status).toBe('active');

      const response = await session.send('Hello!');
      expect(response).toBe('Hello from mock agent!');
      expect(session.tokenCount).toBe(15);
      expect(session.messages.length).toBe(3); // system + user + assistant
    });

    it('should stream a response', async () => {
      const spawner = new AgentSpawner(provider);
      const session = await spawner.spawn(defaultSpawnOptions());

      const events: string[] = [];
      for await (const event of session.stream('Hello!')) {
        if (event.type === 'text' && event.content) {
          events.push(event.content);
        }
      }

      expect(events).toEqual(['Hello', ' from', ' mock']);
      expect(session.messages.length).toBe(3);
      expect(session.tokenCount).toBe(13);
    });

    it('should track session in spawner', async () => {
      const spawner = new AgentSpawner(provider);
      const session = await spawner.spawn(defaultSpawnOptions());

      expect(spawner.get(session.id)).toBe(session);
      expect(spawner.getAll().length).toBe(1);
    });

    it('should support interrupt and resume', async () => {
      const spawner = new AgentSpawner(provider);
      const session = await spawner.spawn(defaultSpawnOptions());

      // Send first message
      await session.send('First message');
      expect(session.status).toBe('active');

      // Interrupt
      session.interrupt();
      expect(session.status).toBe('paused');
      expect(session.phase).toBe('interrupted');

      // Send again should reactivate
      const response = await session.send('Second message');
      expect(response).toBe('Hello from mock agent!');
      expect(session.status).toBe('active');
    });

    it('should reject sends on closed session', async () => {
      const spawner = new AgentSpawner(provider);
      const session = await spawner.spawn(defaultSpawnOptions());

      session.close();
      expect(session.status).toBe('closed');

      await expect(session.send('Should fail')).rejects.toThrow('closed');
    });

    it('should persist session state when adapter provided', async () => {
      const adapter = new SessionAdapter(sessionDir);
      const spawner = new AgentSpawner(provider, adapter);
      const session = await spawner.spawn(defaultSpawnOptions());

      // Send a message (triggers persistence)
      await spawner.message(session.id, 'Hello!');

      // Verify persistence
      const saved = adapter.load(session.id);
      expect(saved).not.toBeNull();
      expect(saved!.messages.length).toBe(3); // system + user + assistant
      expect(saved!.metadata.status).toBe('active');
      expect(saved!.metadata.tokenCount).toBe(15);
    });

    it('should stop a session and persist final state', async () => {
      const adapter = new SessionAdapter(sessionDir);
      const spawner = new AgentSpawner(provider, adapter);
      const session = await spawner.spawn(defaultSpawnOptions());

      await spawner.message(session.id, 'Hello!');
      await spawner.stop(session.id);

      const saved = adapter.load(session.id);
      expect(saved!.metadata.status).toBe('closed');
      expect(spawner.get(session.id)).toBeUndefined();
    });

    it('should resume a session from saved state', async () => {
      const adapter = new SessionAdapter(sessionDir);
      const spawner = new AgentSpawner(provider, adapter);

      // Create and interact with initial session
      const session1 = await spawner.spawn(defaultSpawnOptions());
      await spawner.message(session1.id, 'First message');

      // Resume from saved state
      const session2 = await spawner.resume(session1.id, defaultSpawnOptions());
      expect(session2.id).not.toBe(session1.id); // new session ID
      expect(session2.messages.length).toBe(3); // system (new) + user + assistant (from history)

      // Can continue the conversation
      const response = await session2.send('Follow-up');
      expect(response).toBe('Hello from mock agent!');
    });
  });

  describe('closeAll', () => {
    it('should close all sessions', async () => {
      const spawner = new AgentSpawner(provider);
      await spawner.spawn(defaultSpawnOptions({ agentId: 'agent-1' }));
      await spawner.spawn(defaultSpawnOptions({ agentId: 'agent-2' }));

      expect(spawner.getAll().length).toBe(2);

      await spawner.closeAll();
      expect(spawner.getAll().length).toBe(0);
    });
  });
});
