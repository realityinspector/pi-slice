import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Onboarding Types ---

export type OnboardingStep =
  | 'welcome'
  | 'api-key-check'
  | 'model-selection'
  | 'workspace-setup'
  | 'first-task'
  | 'complete';

export interface OnboardingState {
  currentStep: OnboardingStep;
  completedSteps: OnboardingStep[];
  apiKeyValid: boolean;
  modelsAvailable: number;
  selectedModels: { director: string; worker: string; steward: string };
  workspaceName?: string;
}

export interface FeedServerOptions {
  onboardingState?: OnboardingState | null;
}

const ONBOARDING_STEP_ORDER: OnboardingStep[] = [
  'welcome',
  'api-key-check',
  'model-selection',
  'workspace-setup',
  'first-task',
  'complete',
];

// --- DM Types ---

export interface DMMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: string;
}

export interface DMThread {
  id: string;
  agentName: string;
  agentRole: string;
  messages: DMMessage[];
  createdAt: string;
  lastMessageAt: string;
}

// --- Types ---

export interface FeedComment {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
  timestamp: string;
}

export interface FeedPost {
  id: string;
  agentId?: string;
  agentName?: string;
  agentRole?: string;
  content: string;
  timestamp: string;
  likes: number;
  comments: FeedComment[];
}

// --- Server ---

export class FeedServer {
  private app: express.Express;
  private server: http.Server;
  private wss: WebSocketServer;
  private posts: FeedPost[] = [];
  private dmThreads: Map<string, DMThread> = new Map();
  private onboardingState: OnboardingState | null;

  constructor(private port: number, options?: FeedServerOptions) {
    this.onboardingState = options?.onboardingState ?? null;
    this.app = express();
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, '../client/dist')));

    // --- API routes ---

    this.app.get('/api/health', (_req, res) => {
      res.json({ status: 'ok', uptime: process.uptime() });
    });

    this.app.get('/api/feed', (_req, res) => {
      res.json(this.posts.slice().reverse());
    });

    this.app.post('/api/feed', (req, res) => {
      const { content, agentId, agentName, agentRole } = req.body as {
        content?: string;
        agentId?: string;
        agentName?: string;
        agentRole?: string;
      };
      if (!content || typeof content !== 'string' || !content.trim()) {
        res.status(400).json({ error: 'content is required' });
        return;
      }
      const post = this.addPost({
        content: content.trim(),
        agentId,
        agentName: agentName || 'Anonymous',
        agentRole,
      });
      res.status(201).json(post);
    });

    this.app.post('/api/feed/:id/like', (req, res) => {
      const post = this.posts.find((p) => p.id === req.params.id);
      if (!post) {
        res.status(404).json({ error: 'post not found' });
        return;
      }
      post.likes += 1;
      this.broadcast({ type: 'reaction', data: { postId: post.id, likes: post.likes } });
      res.json({ likes: post.likes });
    });

    this.app.post('/api/feed/:id/comments', (req, res) => {
      const post = this.posts.find((p) => p.id === req.params.id);
      if (!post) {
        res.status(404).json({ error: 'post not found' });
        return;
      }
      const { content, authorId, authorName } = req.body as {
        content?: string;
        authorId?: string;
        authorName?: string;
      };
      if (!content || typeof content !== 'string' || !content.trim()) {
        res.status(400).json({ error: 'content is required' });
        return;
      }
      const comment: FeedComment = {
        id: crypto.randomUUID(),
        authorId: authorId || 'user',
        authorName: authorName || 'Anonymous',
        content: content.trim(),
        timestamp: new Date().toISOString(),
      };
      post.comments.push(comment);
      this.broadcast({ type: 'new-comment', data: { postId: post.id, comment } });
      res.status(201).json(comment);
    });

    // --- Onboarding routes ---

    this.app.get('/api/onboarding', (_req, res) => {
      if (!this.onboardingState) {
        res.json({ active: false, state: null });
        return;
      }
      res.json({ active: true, state: this.onboardingState });
    });

    this.app.post('/api/onboarding/advance', (_req, res) => {
      if (!this.onboardingState) {
        res.json({ active: false, state: null });
        return;
      }
      const currentIndex = ONBOARDING_STEP_ORDER.indexOf(this.onboardingState.currentStep);
      if (currentIndex >= 0 && currentIndex < ONBOARDING_STEP_ORDER.length - 1) {
        this.onboardingState.completedSteps.push(this.onboardingState.currentStep);
        this.onboardingState.currentStep = ONBOARDING_STEP_ORDER[currentIndex + 1];
      }
      if (this.onboardingState.currentStep === 'complete') {
        const finalState = { ...this.onboardingState };
        this.onboardingState = null;
        res.json({ active: false, state: finalState });
        return;
      }
      res.json({ active: true, state: this.onboardingState });
    });

    this.app.post('/api/onboarding/skip', (_req, res) => {
      this.onboardingState = null;
      res.json({ active: false, state: null });
    });

    // --- DM routes ---

    const KNOWN_AGENTS: Record<string, string> = {
      director: 'director',
      alice: 'director',
      worker: 'worker',
      bob: 'worker',
      steward: 'steward',
      carol: 'steward',
    };

    const getOrCreateDM = (agentName: string): DMThread => {
      const existing = this.dmThreads.get(agentName);
      if (existing) return existing;
      const now = new Date().toISOString();
      const thread: DMThread = {
        id: crypto.randomUUID(),
        agentName,
        agentRole: KNOWN_AGENTS[agentName] || 'system',
        messages: [],
        createdAt: now,
        lastMessageAt: now,
      };
      this.dmThreads.set(agentName, thread);
      return thread;
    };

    const generateDirectorResponse = (userMessage: string): string => {
      const lower = userMessage.toLowerCase();
      if (lower.includes('plan') || lower.includes('break down')) {
        return `Here's my proposed plan:\n\n1. Analyze requirements and scope\n2. Break into subtasks:\n   - Task A: Set up data models\n   - Task B: Implement core logic\n   - Task C: Build UI components\n   - Task D: Integration tests\n3. Assign workers and set priorities\n4. Monitor progress and adjust\n\nShall I create these tasks and assign them?`;
      }
      if (lower.includes('status') || lower.includes('progress')) {
        return `Current status report:\n\n- Active plan: Auth System\n- Tasks completed: 2/4\n- Worker (bob): implementing login form\n- Steward (carol): reviewing PR #42\n- No blockers detected\n\nOverall progress: on track.`;
      }
      if (lower.includes('help') || lower.includes('what can')) {
        return `I'm the Director agent. Here's what I can do:\n\n- Plan and break down projects into tasks\n- Assign work to Worker agents\n- Coordinate between Workers and Stewards\n- Report on progress and blockers\n- Reprioritize tasks based on feedback\n\nTry telling me what you want to build, or ask for a status update.`;
      }
      return `I'll work on that. Creating tasks...`;
    };

    this.app.get('/api/dm', (_req, res) => {
      const threads = Array.from(this.dmThreads.values()).sort(
        (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
      );
      res.json(threads);
    });

    this.app.get('/api/dm/:agentName', (req, res) => {
      const thread = getOrCreateDM(req.params.agentName);
      res.json(thread);
    });

    this.app.post('/api/dm/:agentName', (req, res) => {
      const { content } = req.body as { content?: string };
      if (!content || typeof content !== 'string' || !content.trim()) {
        res.status(400).json({ error: 'content is required' });
        return;
      }
      const thread = getOrCreateDM(req.params.agentName);
      const now = new Date().toISOString();

      const userMsg: DMMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: content.trim(),
        timestamp: now,
      };
      thread.messages.push(userMsg);
      thread.lastMessageAt = now;

      // Agent auto-response
      const agentTimestamp = new Date(Date.now() + 500).toISOString();
      const isDirector = thread.agentRole === 'director';
      const responseContent = isDirector
        ? generateDirectorResponse(content)
        : 'I received your message. (Agent responses coming in Phase 2)';

      const agentMsg: DMMessage = {
        id: crypto.randomUUID(),
        role: 'agent',
        content: responseContent,
        timestamp: agentTimestamp,
      };
      thread.messages.push(agentMsg);
      thread.lastMessageAt = agentTimestamp;

      res.status(201).json({ userMessage: userMsg, agentMessage: agentMsg });
    });

    // --- Status & workspace routes ---

    this.app.get('/api/status', (_req, res) => {
      // Derive status from seed posts when available, otherwise return static mock
      const agentNames = new Map<string, { role: string; content: string }>();
      for (const p of this.posts) {
        if (p.agentName && p.agentRole) {
          agentNames.set(p.agentName, { role: p.agentRole, content: p.content });
        }
      }

      const agents: { name: string; role: string; status: string; task?: string }[] = [];

      for (const [name, info] of agentNames) {
        if (info.role === 'director') {
          agents.push({ name, role: 'director', status: 'idle' });
        } else if (info.role === 'worker') {
          // Extract a task hint from last post
          const taskMatch = info.content.match(/(?:implement|add|fix|build|create|update)\s+(.{4,40})/i);
          agents.push({
            name,
            role: 'worker',
            status: 'working',
            task: taskMatch ? taskMatch[1].replace(/[.!]+$/, '').trim() : 'coding',
          });
        } else if (info.role === 'steward') {
          const prMatch = info.content.match(/PR\s*#?\d+/i);
          agents.push({
            name,
            role: 'steward',
            status: 'reviewing',
            task: prMatch ? prMatch[0] : 'reviewing code',
          });
        } else {
          agents.push({ name, role: info.role, status: 'idle' });
        }
      }

      // Fallback mock if no posts yet
      if (agents.length === 0) {
        agents.push(
          { name: 'alice', role: 'director', status: 'idle' },
          { name: 'bob', role: 'worker', status: 'working', task: 'Add login form' },
          { name: 'carol', role: 'steward', status: 'reviewing', task: 'PR #42' },
        );
      }

      res.json({
        agents,
        activePlan: 'Auth System (2/4 tasks complete)',
        repoName: 'pi-slice',
      });
    });

    this.app.get('/api/workspace', (_req, res) => {
      res.json({
        repoName: 'pi-slice',
        branch: 'main',
        dirtyFiles: 0,
      });
    });

    // SPA catch-all
    this.app.get('*', (req, res) => {
      if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, '../client/dist/index.html'));
      }
    });

    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws) => {
      // Send current feed snapshot on connect
      ws.send(JSON.stringify({ type: 'snapshot', data: this.posts.slice().reverse() }));
    });
  }

  /** Add a post programmatically (for agent use). */
  addPost(post: Omit<FeedPost, 'id' | 'timestamp' | 'likes' | 'comments'>): FeedPost {
    const newPost: FeedPost = {
      ...post,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      likes: 0,
      comments: [],
    };
    this.posts.push(newPost);
    this.broadcast({ type: 'new-post', data: newPost });
    return newPost;
  }

  /** Broadcast a JSON event to all connected WebSocket clients. */
  broadcast(event: { type: string; data: unknown }): void {
    const msg = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  }

  /** Start listening. */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => resolve());
    });
  }

  /** Gracefully stop the server. */
  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      for (const client of this.wss.clients) {
        client.close();
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
