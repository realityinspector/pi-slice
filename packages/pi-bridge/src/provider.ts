/**
 * SlicePiProvider — OpenRouter LLM provider for Slice
 *
 * Uses the OpenRouter REST API (OpenAI-compatible chat completions format)
 * with Node.js built-in fetch (Node 22+).
 */

// ── Public types ────────────────────────────────────────────────────────────

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  tools?: ToolDefinition[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface StreamEvent {
  type: 'text' | 'tool_use' | 'error' | 'done';
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  error?: string;
  usage?: UsageInfo;
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
  /** Rate-limit metadata extracted from OpenRouter response headers */
  rateLimit?: RateLimitInfo;
}

export interface RateLimitInfo {
  /** Requests remaining in the current window */
  requestsRemaining?: number;
  /** Requests limit for the current window */
  requestsLimit?: number;
  /** Time (epoch seconds) when the rate limit resets */
  requestsReset?: string;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
}

// ── Internal helpers ────────────────────────────────────────────────────────

interface OpenRouterChoice {
  message: {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
  finish_reason?: string;
}

interface OpenRouterUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface OpenRouterResponse {
  id: string;
  choices: OpenRouterChoice[];
  usage?: OpenRouterUsage;
}

interface OpenRouterModel {
  id: string;
  name: string;
  pricing: { prompt: string; completion: string };
}

interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

interface OpenRouterDelta {
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenRouterStreamChunk {
  id: string;
  choices: Array<{
    delta: OpenRouterDelta;
    finish_reason?: string | null;
  }>;
  usage?: OpenRouterUsage;
}

function extractRateLimit(headers: Headers): RateLimitInfo | undefined {
  const remaining = headers.get('x-ratelimit-remaining');
  const limit = headers.get('x-ratelimit-limit');
  const reset = headers.get('x-ratelimit-reset');

  if (!remaining && !limit && !reset) return undefined;

  return {
    requestsRemaining: remaining ? parseInt(remaining, 10) : undefined,
    requestsLimit: limit ? parseInt(limit, 10) : undefined,
    requestsReset: reset ?? undefined,
  };
}

function extractCostFromHeaders(headers: Headers): number | undefined {
  // OpenRouter may include cost info in a custom header
  const cost = headers.get('x-openrouter-cost');
  if (cost) return parseFloat(cost);
  return undefined;
}

function mapUsage(u?: OpenRouterUsage, headers?: Headers): UsageInfo {
  const rateLimit = headers ? extractRateLimit(headers) : undefined;
  const headerCost = headers ? extractCostFromHeaders(headers) : undefined;

  return {
    promptTokens: u?.prompt_tokens ?? 0,
    completionTokens: u?.completion_tokens ?? 0,
    totalTokens: u?.total_tokens ?? 0,
    cost: headerCost,
    rateLimit,
  };
}

function buildToolsPayload(tools?: ToolDefinition[]) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ── Provider ────────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4';

export class SlicePiProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor(config: { openrouterApiKey: string; baseUrl?: string }) {
    if (!config.openrouterApiKey) {
      throw new Error('SlicePiProvider requires an openrouterApiKey');
    }
    this.apiKey = config.openrouterApiKey;
    this.baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1';
  }

  // ── Non-streaming completion ──────────────────────────────────────────

  async complete(
    messages: Message[],
    options?: CompletionOptions,
  ): Promise<{ content: string; usage: UsageInfo }> {
    const body = this.buildRequestBody(messages, options, false);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenRouter API error ${res.status}: ${text}`);
    }

    const json = (await res.json()) as OpenRouterResponse;
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? '';
    const usage = mapUsage(json.usage, res.headers);

    return { content, usage };
  }

  // ── Streaming completion ──────────────────────────────────────────────

  async *stream(
    messages: Message[],
    options?: CompletionOptions,
  ): AsyncGenerator<StreamEvent> {
    const body = this.buildRequestBody(messages, options, true);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      yield { type: 'error', error: `OpenRouter API error ${res.status}: ${text}` };
      return;
    }

    if (!res.body) {
      yield { type: 'error', error: 'Response body is null' };
      return;
    }

    // Capture response headers for rate-limit / cost extraction
    const responseHeaders = res.headers;

    // Accumulate partial tool call data across chunks
    const toolCalls: Map<number, { name: string; args: string }> = new Map();
    let lastUsage: OpenRouterUsage | undefined;

    const decoder = new TextDecoder();
    let buffer = '';

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep the last potentially-incomplete line in the buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue; // skip empty lines and SSE comments

          if (trimmed === 'data: [DONE]') {
            // Emit any accumulated tool calls before done
            for (const [, tc] of toolCalls) {
              let toolInput: Record<string, unknown> = {};
              try {
                toolInput = JSON.parse(tc.args) as Record<string, unknown>;
              } catch {
                // args may not be valid JSON
              }
              yield { type: 'tool_use', toolName: tc.name, toolInput };
            }
            yield { type: 'done', usage: mapUsage(lastUsage, responseHeaders) };
            return;
          }

          if (!trimmed.startsWith('data: ')) continue;
          const payload = trimmed.slice(6);

          let chunk: OpenRouterStreamChunk;
          try {
            chunk = JSON.parse(payload) as OpenRouterStreamChunk;
          } catch {
            continue; // skip unparseable lines
          }

          if (chunk.usage) {
            lastUsage = chunk.usage;
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          // Text content
          if (delta.content) {
            yield { type: 'text', content: delta.content };
          }

          // Tool call deltas (streamed incrementally)
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing = toolCalls.get(tc.index);
              if (!existing) {
                toolCalls.set(tc.index, {
                  name: tc.function?.name ?? '',
                  args: tc.function?.arguments ?? '',
                });
              } else {
                if (tc.function?.name) existing.name += tc.function.name;
                if (tc.function?.arguments) existing.args += tc.function.arguments;
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // If we exit the loop without [DONE], still emit accumulated tool calls and done
    for (const [, tc] of toolCalls) {
      let toolInput: Record<string, unknown> = {};
      try {
        toolInput = JSON.parse(tc.args) as Record<string, unknown>;
      } catch {
        // args may not be valid JSON
      }
      yield { type: 'tool_use', toolName: tc.name, toolInput };
    }
    yield { type: 'done', usage: mapUsage(lastUsage, responseHeaders) };
  }

  // ── List available models ─────────────────────────────────────────────

  async listModels(): Promise<
    Array<{ id: string; name: string; pricing: { prompt: number; completion: number } }>
  > {
    const res = await fetch(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: this.headers(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenRouter API error ${res.status}: ${text}`);
    }

    const json = (await res.json()) as OpenRouterModelsResponse;

    return json.data.map((m) => ({
      id: m.id,
      name: m.name,
      pricing: {
        prompt: parseFloat(m.pricing.prompt),
        completion: parseFloat(m.pricing.completion),
      },
    }));
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/realityinspector/pi-slice',
      'X-Title': 'Slice',
    };
  }

  private buildRequestBody(
    messages: Message[],
    options?: CompletionOptions,
    stream?: boolean,
  ) {
    const allMessages: Array<Record<string, unknown>> = [];

    // Prepend system prompt if provided
    if (options?.systemPrompt) {
      allMessages.push({ role: 'system', content: options.systemPrompt });
    }

    for (const m of messages) {
      const msg: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.name) msg.name = m.name;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      allMessages.push(msg);
    }

    const body: Record<string, unknown> = {
      model: options?.model ?? DEFAULT_MODEL,
      messages: allMessages,
    };

    if (stream) body.stream = true;
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;

    const tools = buildToolsPayload(options?.tools);
    if (tools) body.tools = tools;

    return body;
  }
}
