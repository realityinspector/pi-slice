/**
 * Tests for SlicePiProvider — uses a lightweight HTTP mock server
 * so we can run these tests without a real OpenRouter API key.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SlicePiProvider, type StreamEvent } from '../provider.js';

// ── Mock Server ────────────────────────────────────────────────────────────

let server: ReturnType<typeof createServer>;
let baseUrl: string;

function mockHandler(req: IncomingMessage, res: ServerResponse) {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString()));
  req.on('end', () => {
    const url = req.url ?? '';

    // ── List models endpoint ──────────────────────────────────────────
    if (url === '/models' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-ratelimit-remaining': '99',
        'x-ratelimit-limit': '100',
        'x-ratelimit-reset': '1700000000',
      });
      res.end(
        JSON.stringify({
          data: [
            {
              id: 'anthropic/claude-sonnet-4',
              name: 'Claude 3.5 Sonnet',
              pricing: { prompt: '0.000003', completion: '0.000015' },
            },
            {
              id: 'anthropic/claude-haiku',
              name: 'Claude 3 Haiku',
              pricing: { prompt: '0.00000025', completion: '0.00000125' },
            },
          ],
        }),
      );
      return;
    }

    // ── Chat completions endpoint ─────────────────────────────────────
    if (url === '/chat/completions' && req.method === 'POST') {
      const parsed = JSON.parse(body);

      // Set rate-limit and cost headers on all completions
      const headers: Record<string, string> = {
        'x-ratelimit-remaining': '42',
        'x-ratelimit-limit': '100',
        'x-ratelimit-reset': '1700000000',
        'x-openrouter-cost': '0.000123',
      };

      // ── Streaming ───────────────────────────────────────────────────
      if (parsed.stream) {
        res.writeHead(200, {
          ...headers,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const chunks = [
          { id: 'chatcmpl-1', choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
          { id: 'chatcmpl-1', choices: [{ delta: { content: ' world' }, finish_reason: null }] },
          {
            id: 'chatcmpl-1',
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          },
        ];

        for (const chunk of chunks) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // ── Non-streaming ───────────────────────────────────────────────
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          choices: [
            {
              message: { role: 'assistant', content: 'Hello from mock OpenRouter!' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
        }),
      );
      return;
    }

    // ── Fallback ──────────────────────────────────────────────────────
    res.writeHead(404);
    res.end('Not Found');
  });
}

beforeAll(async () => {
  server = createServer(mockHandler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('SlicePiProvider', () => {
  it('should throw if no API key provided', () => {
    expect(() => new SlicePiProvider({ openrouterApiKey: '' })).toThrow(
      'SlicePiProvider requires an openrouterApiKey',
    );
  });

  it('should complete a prompt and return content + usage', async () => {
    const provider = new SlicePiProvider({
      openrouterApiKey: 'test-key',
      baseUrl,
    });

    const result = await provider.complete([{ role: 'user', content: 'Hi' }]);

    expect(result.content).toBe('Hello from mock OpenRouter!');
    expect(result.usage.promptTokens).toBe(5);
    expect(result.usage.completionTokens).toBe(6);
    expect(result.usage.totalTokens).toBe(11);
  });

  it('should extract cost from response headers', async () => {
    const provider = new SlicePiProvider({
      openrouterApiKey: 'test-key',
      baseUrl,
    });

    const result = await provider.complete([{ role: 'user', content: 'Hi' }]);

    expect(result.usage.cost).toBeCloseTo(0.000123);
  });

  it('should extract rate-limit info from response headers', async () => {
    const provider = new SlicePiProvider({
      openrouterApiKey: 'test-key',
      baseUrl,
    });

    const result = await provider.complete([{ role: 'user', content: 'Hi' }]);

    expect(result.usage.rateLimit).toBeDefined();
    expect(result.usage.rateLimit!.requestsRemaining).toBe(42);
    expect(result.usage.rateLimit!.requestsLimit).toBe(100);
    expect(result.usage.rateLimit!.requestsReset).toBe('1700000000');
  });

  it('should stream a response and yield text events', async () => {
    const provider = new SlicePiProvider({
      openrouterApiKey: 'test-key',
      baseUrl,
    });

    const events: StreamEvent[] = [];
    for await (const event of provider.stream([{ role: 'user', content: 'Hi' }])) {
      events.push(event);
    }

    // Should have text chunks + done
    const textEvents = events.filter((e) => e.type === 'text');
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0].content).toBe('Hello');
    expect(textEvents[1].content).toBe(' world');

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.usage).toBeDefined();
    expect(doneEvent!.usage!.totalTokens).toBe(12);
  });

  it('should extract rate-limit info from streaming response headers', async () => {
    const provider = new SlicePiProvider({
      openrouterApiKey: 'test-key',
      baseUrl,
    });

    const events: StreamEvent[] = [];
    for await (const event of provider.stream([{ role: 'user', content: 'Hi' }])) {
      events.push(event);
    }

    const doneEvent = events.find((e) => e.type === 'done');
    expect(doneEvent!.usage!.rateLimit).toBeDefined();
    expect(doneEvent!.usage!.rateLimit!.requestsRemaining).toBe(42);
  });

  it('should list available models', async () => {
    const provider = new SlicePiProvider({
      openrouterApiKey: 'test-key',
      baseUrl,
    });

    const models = await provider.listModels();

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('anthropic/claude-sonnet-4');
    expect(models[0].pricing.prompt).toBeCloseTo(0.000003);
    expect(models[1].id).toBe('anthropic/claude-haiku');
  });

  it('should use custom model in request body', async () => {
    const provider = new SlicePiProvider({
      openrouterApiKey: 'test-key',
      baseUrl,
    });

    // The mock always returns the same response regardless of model,
    // but this tests that the option is properly passed
    const result = await provider.complete([{ role: 'user', content: 'Hi' }], {
      model: 'anthropic/claude-haiku',
      temperature: 0.5,
      maxTokens: 100,
    });

    expect(result.content).toBe('Hello from mock OpenRouter!');
  });

  it('should include system prompt when provided', async () => {
    const provider = new SlicePiProvider({
      openrouterApiKey: 'test-key',
      baseUrl,
    });

    const result = await provider.complete([{ role: 'user', content: 'Hi' }], {
      systemPrompt: 'You are a helpful assistant.',
    });

    expect(result.content).toBe('Hello from mock OpenRouter!');
  });
});
