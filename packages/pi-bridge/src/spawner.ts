/**
 * AgentSpawner — creates and manages agent sessions backed by SlicePiProvider.
 *
 * Supports two modes:
 * - SDK mode (default): In-process sessions using the SlicePiProvider directly
 * - RPC mode: Subprocess sessions communicating via stdin/stdout JSONL protocol
 */

import { SlicePiProvider, Message, StreamEvent, CompletionOptions, UsageInfo } from './provider.js';
import { SessionAdapter, type SessionMetadata } from './session-adapter.js';
import { randomUUID } from 'node:crypto';
import { ChildProcess, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

// ── Public types ────────────────────────────────────────────────────────────

/** Mode for agent session communication */
export type SpawnMode = 'sdk' | 'rpc';

export interface SpawnOptions {
  /** Quarry entity ID for this agent */
  agentId: string;
  /** OpenRouter model ID (e.g. 'anthropic/claude-sonnet-4') */
  model: string;
  /** System prompt for the agent */
  systemPrompt: string;
  /** Working directory for the agent process (used in RPC mode) */
  workingDirectory?: string;
  /** Directory for persisting session JSONL files */
  sessionDir?: string;
  /** Tool definitions available to the agent */
  tools?: CompletionOptions['tools'];
  /** Callback for streaming events */
  onEvent?: (event: StreamEvent) => void;
  /** Spawn mode: 'sdk' (in-process) or 'rpc' (subprocess) */
  mode?: SpawnMode;
  /** For RPC mode: path to the subprocess executable */
  rpcCommand?: string;
  /** For RPC mode: arguments to pass to the subprocess */
  rpcArgs?: string[];
  /** For RPC mode: environment variables for the subprocess */
  rpcEnv?: Record<string, string>;
  /** Extensions to load (passed to agent as available tools/capabilities) */
  extensions?: string[];
  /** Maximum tokens before session compaction is triggered */
  compactionThreshold?: number;
  /** Maximum number of messages to keep in history (default: 20). System prompt is always preserved. */
  maxMessages?: number;
}

export type SessionStatus = 'active' | 'paused' | 'closed';

/** Lifecycle phase of a session */
export type SessionLifecyclePhase = 'starting' | 'ready' | 'messaging' | 'interrupted' | 'closing' | 'closed';

export interface AgentSession {
  readonly id: string;
  readonly agentId: string;
  readonly model: string;
  readonly mode: SpawnMode;
  status: SessionStatus;
  phase: SessionLifecyclePhase;
  readonly messages: Message[];
  readonly startedAt: Date;
  lastMessageAt?: Date;
  tokenCount: number;

  /** Send a message and wait for the full response */
  send(message: string): Promise<string>;
  /** Send a message and stream the response as events */
  stream(message: string): AsyncGenerator<StreamEvent>;
  /** Interrupt current generation, save partial state */
  interrupt(): void;
  /** Close the session, finalize state */
  close(): void;
}

// ── RPC Protocol types ──────────────────────────────────────────────────────

/** Messages sent TO the subprocess via stdin */
interface RpcRequest {
  type: 'init' | 'message' | 'interrupt' | 'close';
  id: string;
  payload?: {
    model?: string;
    systemPrompt?: string;
    tools?: CompletionOptions['tools'];
    extensions?: string[];
    content?: string;
  };
}

/** Messages received FROM the subprocess via stdout */
interface RpcResponse {
  type: 'ready' | 'text' | 'tool_use' | 'done' | 'error' | 'closed';
  requestId: string;
  content?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  error?: string;
  usage?: UsageInfo;
}

// ── SDK Session implementation ──────────────────────────────────────────────

class SdkAgentSession implements AgentSession {
  readonly id: string;
  readonly agentId: string;
  readonly model: string;
  readonly mode: SpawnMode = 'sdk';
  status: SessionStatus = 'active';
  phase: SessionLifecyclePhase = 'ready';
  readonly messages: Message[] = [];
  readonly startedAt: Date;
  lastMessageAt?: Date;
  tokenCount = 0;

  private provider: SlicePiProvider;
  private tools?: CompletionOptions['tools'];
  private onEvent?: (event: StreamEvent) => void;
  private abortController: AbortController | null = null;
  private maxMessages: number;

  constructor(
    provider: SlicePiProvider,
    options: SpawnOptions,
    existingMessages?: Message[],
  ) {
    this.id = randomUUID();
    this.agentId = options.agentId;
    this.model = options.model;
    this.provider = provider;
    this.tools = options.tools;
    this.onEvent = options.onEvent;
    this.maxMessages = options.maxMessages ?? 20;
    this.startedAt = new Date();

    // Seed with system prompt as the first message
    this.messages.push({ role: 'system', content: options.systemPrompt });

    // Append any existing history (for resume)
    if (existingMessages) {
      for (const m of existingMessages) {
        this.messages.push(m);
      }
    }
  }

  /**
   * Trim messages to keep history bounded. Preserves the system prompt (first message)
   * and the most recent (maxMessages - 1) messages.
   */
  private trimMessages(): void {
    if (this.messages.length <= this.maxMessages) return;
    const system = this.messages[0];
    this.messages.splice(0, this.messages.length, system, ...this.messages.slice(-(this.maxMessages - 1)));
  }

  async send(message: string): Promise<string> {
    this.ensureActive();
    this.phase = 'messaging';
    this.trimMessages();

    this.messages.push({ role: 'user', content: message });
    this.lastMessageAt = new Date();

    try {
      const { content, usage } = await this.provider.complete(this.messages, {
        model: this.model,
        tools: this.tools,
      });

      this.messages.push({ role: 'assistant', content });
      this.addUsage(usage);
      this.lastMessageAt = new Date();
      this.phase = 'ready';

      return content;
    } catch (err) {
      this.phase = 'ready';
      throw err;
    }
  }

  async *stream(message: string): AsyncGenerator<StreamEvent> {
    this.ensureActive();
    this.phase = 'messaging';
    this.trimMessages();

    this.messages.push({ role: 'user', content: message });
    this.lastMessageAt = new Date();

    this.abortController = new AbortController();

    let fullContent = '';

    const gen = this.provider.stream(this.messages, {
      model: this.model,
      tools: this.tools,
    });

    try {
      for await (const event of gen) {
        if (this.abortController.signal.aborted) {
          this.phase = 'interrupted';
          break;
        }

        if (event.type === 'text' && event.content) {
          fullContent += event.content;
        }

        if (event.type === 'done' && event.usage) {
          this.addUsage(event.usage);
        }

        if (this.onEvent) {
          this.onEvent(event);
        }

        yield event;
      }
    } finally {
      this.abortController = null;
    }

    if (fullContent) {
      this.messages.push({ role: 'assistant', content: fullContent });
      this.lastMessageAt = new Date();
    }

    if (this.phase === 'messaging') {
      this.phase = 'ready';
    }
  }

  interrupt(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.status = 'paused';
    this.phase = 'interrupted';
  }

  close(): void {
    this.interrupt();
    this.status = 'closed';
    this.phase = 'closed';
  }

  private ensureActive(): void {
    if (this.status === 'closed') {
      throw new Error(`Session ${this.id} is closed`);
    }
    if (this.status === 'paused') {
      this.status = 'active';
      this.phase = 'ready';
    }
  }

  private addUsage(usage: UsageInfo): void {
    this.tokenCount += usage.totalTokens;
  }
}

// ── RPC Session implementation ──────────────────────────────────────────────

class RpcAgentSession extends EventEmitter implements AgentSession {
  readonly id: string;
  readonly agentId: string;
  readonly model: string;
  readonly mode: SpawnMode = 'rpc';
  status: SessionStatus = 'active';
  phase: SessionLifecyclePhase = 'starting';
  readonly messages: Message[] = [];
  readonly startedAt: Date;
  lastMessageAt?: Date;
  tokenCount = 0;

  private process: ChildProcess | null = null;
  private pendingResponses = new Map<string, {
    resolve: (events: RpcResponse[]) => void;
    reject: (err: Error) => void;
    events: RpcResponse[];
  }>();
  private onEvent?: (event: StreamEvent) => void;

  constructor(
    private options: SpawnOptions,
    existingMessages?: Message[],
  ) {
    super();
    this.id = randomUUID();
    this.agentId = options.agentId;
    this.model = options.model;
    this.onEvent = options.onEvent;
    this.startedAt = new Date();

    this.messages.push({ role: 'system', content: options.systemPrompt });

    if (existingMessages) {
      for (const m of existingMessages) {
        this.messages.push(m);
      }
    }
  }

  /** Start the subprocess and send init message */
  async start(): Promise<void> {
    const cmd = this.options.rpcCommand ?? 'node';
    const args = this.options.rpcArgs ?? [];

    this.process = spawn(cmd, args, {
      cwd: this.options.workingDirectory,
      env: {
        ...process.env,
        ...this.options.rpcEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Parse JSONL from stdout
    if (this.process.stdout) {
      const rl = createInterface({ input: this.process.stdout });
      rl.on('line', (line) => {
        try {
          const response = JSON.parse(line) as RpcResponse;
          this.handleResponse(response);
        } catch {
          // Ignore non-JSON lines (e.g. debug output)
        }
      });
    }

    this.process.on('exit', (code) => {
      this.status = 'closed';
      this.phase = 'closed';
      // Reject any pending requests
      for (const [, pending] of this.pendingResponses) {
        pending.reject(new Error(`RPC process exited with code ${code}`));
      }
      this.pendingResponses.clear();
      this.emit('exit', code);
    });

    // Send init
    const initId = randomUUID();
    await this.sendRpc({
      type: 'init',
      id: initId,
      payload: {
        model: this.model,
        systemPrompt: this.options.systemPrompt,
        tools: this.options.tools,
        extensions: this.options.extensions,
      },
    });

    this.phase = 'ready';
  }

  async send(message: string): Promise<string> {
    this.ensureActive();
    this.phase = 'messaging';

    this.messages.push({ role: 'user', content: message });
    this.lastMessageAt = new Date();

    const requestId = randomUUID();
    const events = await this.sendRpc({
      type: 'message',
      id: requestId,
      payload: { content: message },
    });

    let fullContent = '';
    for (const event of events) {
      if (event.type === 'text' && event.content) {
        fullContent += event.content;
      }
      if (event.type === 'done' && event.usage) {
        this.addUsage(event.usage);
      }
    }

    if (fullContent) {
      this.messages.push({ role: 'assistant', content: fullContent });
      this.lastMessageAt = new Date();
    }

    this.phase = 'ready';
    return fullContent;
  }

  async *stream(message: string): AsyncGenerator<StreamEvent> {
    this.ensureActive();
    this.phase = 'messaging';

    this.messages.push({ role: 'user', content: message });
    this.lastMessageAt = new Date();

    const requestId = randomUUID();
    let fullContent = '';

    // Set up a streaming listener for this request
    const eventQueue: StreamEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let done = false;

    const handler = (response: RpcResponse) => {
      if (response.requestId !== requestId) return;

      const streamEvent = this.rpcToStreamEvent(response);
      if (streamEvent) {
        eventQueue.push(streamEvent);
        if (this.onEvent) {
          this.onEvent(streamEvent);
        }
      }

      if (response.type === 'done' || response.type === 'error') {
        done = true;
        if (response.usage) {
          this.addUsage(response.usage);
        }
      }

      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    this.on('rpc-response', handler);

    // Send the message
    this.writeRpc({
      type: 'message',
      id: requestId,
      payload: { content: message },
    });

    try {
      while (!done) {
        if (eventQueue.length > 0) {
          const event = eventQueue.shift()!;
          if (event.type === 'text' && event.content) {
            fullContent += event.content;
          }
          yield event;
        } else {
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
        }
      }

      // Drain remaining events
      while (eventQueue.length > 0) {
        const event = eventQueue.shift()!;
        if (event.type === 'text' && event.content) {
          fullContent += event.content;
        }
        yield event;
      }
    } finally {
      this.removeListener('rpc-response', handler);
    }

    if (fullContent) {
      this.messages.push({ role: 'assistant', content: fullContent });
      this.lastMessageAt = new Date();
    }

    if (this.phase === 'messaging') {
      this.phase = 'ready';
    }
  }

  interrupt(): void {
    if (this.process && !this.process.killed) {
      this.writeRpc({ type: 'interrupt', id: randomUUID() });
    }
    this.status = 'paused';
    this.phase = 'interrupted';
  }

  close(): void {
    this.phase = 'closing';
    if (this.process && !this.process.killed) {
      this.writeRpc({ type: 'close', id: randomUUID() });
      // Give 5s for graceful shutdown then force kill
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGTERM');
        }
      }, 5000);
    }
    this.status = 'closed';
    this.phase = 'closed';
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private ensureActive(): void {
    if (this.status === 'closed') {
      throw new Error(`Session ${this.id} is closed`);
    }
    if (!this.process || this.process.killed) {
      throw new Error(`Session ${this.id} subprocess is not running`);
    }
    if (this.status === 'paused') {
      this.status = 'active';
      this.phase = 'ready';
    }
  }

  private addUsage(usage: UsageInfo): void {
    this.tokenCount += usage.totalTokens;
  }

  private writeRpc(request: RpcRequest): void {
    if (this.process?.stdin?.writable) {
      this.process.stdin.write(JSON.stringify(request) + '\n');
    }
  }

  private sendRpc(request: RpcRequest): Promise<RpcResponse[]> {
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, events: [] as RpcResponse[] };
      this.pendingResponses.set(request.id, pending);

      // Set up a handler for collecting events
      const handler = (response: RpcResponse) => {
        if (response.requestId !== request.id) return;
        pending.events.push(response);

        if (response.type === 'done' || response.type === 'error' || response.type === 'ready' || response.type === 'closed') {
          this.removeListener('rpc-response', handler);
          this.pendingResponses.delete(request.id);
          if (response.type === 'error') {
            reject(new Error(response.error ?? 'RPC error'));
          } else {
            resolve(pending.events);
          }
        }
      };

      this.on('rpc-response', handler);
      this.writeRpc(request);

      // Timeout after 5 minutes
      setTimeout(() => {
        if (this.pendingResponses.has(request.id)) {
          this.pendingResponses.delete(request.id);
          this.removeListener('rpc-response', handler);
          reject(new Error(`RPC request ${request.id} timed out`));
        }
      }, 300_000);
    });
  }

  private handleResponse(response: RpcResponse): void {
    this.emit('rpc-response', response);
  }

  private rpcToStreamEvent(response: RpcResponse): StreamEvent | null {
    switch (response.type) {
      case 'text':
        return { type: 'text', content: response.content };
      case 'tool_use':
        return { type: 'tool_use', toolName: response.toolName, toolInput: response.toolInput };
      case 'done':
        return { type: 'done', usage: response.usage };
      case 'error':
        return { type: 'error', error: response.error };
      default:
        return null;
    }
  }
}

// ── Spawner ─────────────────────────────────────────────────────────────────

export class AgentSpawner {
  private provider: SlicePiProvider;
  private sessions = new Map<string, AgentSession>();
  private sessionAdapter?: SessionAdapter;
  private readyCachedAt = 0;
  private readyCached = false;
  private static readonly READY_CACHE_TTL = 60000;

  constructor(provider: SlicePiProvider, sessionAdapter?: SessionAdapter) {
    this.provider = provider;
    this.sessionAdapter = sessionAdapter;
  }

  /**
   * Test provider readiness with a tiny completion.
   * Result is cached for 60 seconds.
   */
  async ready(): Promise<boolean> {
    const now = Date.now();
    if (now - this.readyCachedAt < AgentSpawner.READY_CACHE_TTL) {
      return this.readyCached;
    }
    try {
      await this.provider.complete(
        [{ role: 'user', content: 'ping' }],
        { maxTokens: 1 },
      );
      this.readyCached = true;
    } catch {
      this.readyCached = false;
    }
    this.readyCachedAt = now;
    return this.readyCached;
  }

  /**
   * Spawn a new agent session.
   * In SDK mode, creates an in-process session using SlicePiProvider.
   * In RPC mode, spawns a subprocess and communicates via stdin/stdout JSONL.
   * Checks provider readiness first (cached for 60s).
   */
  async spawn(options: SpawnOptions): Promise<AgentSession> {
    const isReady = await this.ready();
    if (!isReady) {
      throw new Error('Provider is not ready — cannot spawn agent session. Check API key and network connectivity.');
    }

    const mode = options.mode ?? 'sdk';

    let session: AgentSession;

    if (mode === 'rpc') {
      const rpcSession = new RpcAgentSession(options);
      await rpcSession.start();
      session = rpcSession;
    } else {
      session = new SdkAgentSession(this.provider, options);
    }

    this.sessions.set(session.id, session);

    // Persist initial session state
    this.persistSession(session);

    return session;
  }

  /**
   * Resume a session from a previously saved session ID.
   * Loads message history from the session adapter and creates a new session
   * with the saved conversation state.
   */
  async resume(sessionId: string, options: SpawnOptions): Promise<AgentSession> {
    let history: Message[] | undefined;

    // Try to load from session adapter
    if (this.sessionAdapter) {
      const saved = this.sessionAdapter.load(sessionId);
      if (saved) {
        history = saved.messages;
      }
    }

    if (!history) {
      throw new Error(`Session ${sessionId} not found for resume`);
    }

    // Filter out the system prompt from history (it will be re-added by the session constructor)
    const nonSystemMessages = history.filter(m => m.role !== 'system');

    const mode = options.mode ?? 'sdk';
    let session: AgentSession;

    if (mode === 'rpc') {
      const rpcSession = new RpcAgentSession(options, nonSystemMessages);
      await rpcSession.start();
      session = rpcSession;
    } else {
      session = new SdkAgentSession(this.provider, options, nonSystemMessages);
    }

    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Send a message to a running agent session.
   */
  async message(sessionId: string, message: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const response = await session.send(message);
    this.persistSession(session);
    return response;
  }

  /**
   * Stop (close) an agent session gracefully.
   * Persists final state before closing.
   */
  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    session.close();
    this.persistSession(session);
    this.sessions.delete(sessionId);
  }

  /**
   * Get a session by ID.
   */
  get(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all tracked sessions.
   */
  getAll(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Close all sessions.
   */
  async closeAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.close();
      this.persistSession(session);
    }
    this.sessions.clear();
  }

  /**
   * Persist session state to the session adapter (if configured).
   */
  private persistSession(session: AgentSession): void {
    if (!this.sessionAdapter) return;

    const metadata: SessionMetadata = {
      sessionId: session.id,
      agentId: session.agentId,
      model: session.model,
      startedAt: session.startedAt.toISOString(),
      lastMessageAt: session.lastMessageAt?.toISOString(),
      status: session.status,
      tokenCount: session.tokenCount,
      messageCount: session.messages.length,
      mode: session.mode,
      phase: session.phase,
    };

    this.sessionAdapter.save(session.id, session.messages, metadata);
  }
}
