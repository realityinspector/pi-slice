/**
 * AgentSpawner — creates and manages agent sessions backed by SlicePiProvider.
 */

import { SlicePiProvider, Message, StreamEvent, CompletionOptions, UsageInfo } from './provider.js';
import { randomUUID } from 'node:crypto';

// ── Public types ────────────────────────────────────────────────────────────

export interface SpawnOptions {
  agentId: string;
  model: string;
  systemPrompt: string;
  workingDirectory?: string;
  sessionDir?: string;
  tools?: CompletionOptions['tools'];
  onEvent?: (event: StreamEvent) => void;
}

export type SessionStatus = 'active' | 'paused' | 'closed';

export interface AgentSession {
  readonly id: string;
  readonly agentId: string;
  readonly model: string;
  status: SessionStatus;
  readonly messages: Message[];
  readonly startedAt: Date;
  lastMessageAt?: Date;
  tokenCount: number;

  send(message: string): Promise<string>;
  stream(message: string): AsyncGenerator<StreamEvent>;
  interrupt(): void;
  close(): void;
}

// ── Session implementation ──────────────────────────────────────────────────

class AgentSessionImpl implements AgentSession {
  readonly id: string;
  readonly agentId: string;
  readonly model: string;
  status: SessionStatus = 'active';
  readonly messages: Message[] = [];
  readonly startedAt: Date;
  lastMessageAt?: Date;
  tokenCount = 0;

  private provider: SlicePiProvider;
  private tools?: CompletionOptions['tools'];
  private onEvent?: (event: StreamEvent) => void;
  private abortController: AbortController | null = null;

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
   * Send a user message, wait for a full response, and return the content.
   */
  async send(message: string): Promise<string> {
    this.ensureActive();

    this.messages.push({ role: 'user', content: message });
    this.lastMessageAt = new Date();

    const { content, usage } = await this.provider.complete(this.messages, {
      model: this.model,
      tools: this.tools,
    });

    this.messages.push({ role: 'assistant', content });
    this.addUsage(usage);
    this.lastMessageAt = new Date();

    return content;
  }

  /**
   * Send a user message and stream the response as events.
   */
  async *stream(message: string): AsyncGenerator<StreamEvent> {
    this.ensureActive();

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
        // Check for abort between chunks
        if (this.abortController.signal.aborted) {
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

    // Append the accumulated assistant response
    if (fullContent) {
      this.messages.push({ role: 'assistant', content: fullContent });
      this.lastMessageAt = new Date();
    }
  }

  /**
   * Abort the current streaming operation.
   */
  interrupt(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.status = 'paused';
  }

  /**
   * Mark this session as closed. No further messages can be sent.
   */
  close(): void {
    this.interrupt();
    this.status = 'closed';
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private ensureActive(): void {
    if (this.status === 'closed') {
      throw new Error(`Session ${this.id} is closed`);
    }
    // Reactivate a paused session on next send
    if (this.status === 'paused') {
      this.status = 'active';
    }
  }

  private addUsage(usage: UsageInfo): void {
    this.tokenCount += usage.totalTokens;
  }
}

// ── Spawner ─────────────────────────────────────────────────────────────────

export class AgentSpawner {
  private provider: SlicePiProvider;
  private sessions = new Map<string, AgentSession>();

  constructor(provider: SlicePiProvider) {
    this.provider = provider;
  }

  /**
   * Spawn a new agent session with the given options.
   */
  async spawn(options: SpawnOptions): Promise<AgentSession> {
    const session = new AgentSessionImpl(this.provider, options);
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Resume a session from previously saved message history.
   * The first message in `history` should be the system prompt.
   */
  async resume(sessionId: string, history: Message[], options: SpawnOptions): Promise<AgentSession> {
    const session = new AgentSessionImpl(this.provider, options, history);
    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Get a session by ID.
   */
  get(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get all active sessions.
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
    }
    this.sessions.clear();
  }
}
