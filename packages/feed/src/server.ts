import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import type { TaskQueue, TaskStatus } from '@slice/orchestrator';

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

/**
 * Minimal DB interface matching StorageBackend's core methods.
 */
export interface FeedDb {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): { changes: number };
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
}

export interface FeedServerOptions {
  onboardingState?: OnboardingState | null;
  provider?: { complete: (messages: any[], options?: any) => Promise<{ content: string; usage: any }> };
  taskQueue?: TaskQueue;
  db?: FeedDb;
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
  editedAt?: string;
  imageUrl?: string;
  imageAlt?: string;
}

// --- Mention Parser ---

function parseMention(content: string): { target: string; message: string } | null {
  const match = content.match(/^@(director|worker|steward|all)\b\s*(.*)/is);
  if (!match) return null;
  return { target: match[1].toLowerCase(), message: match[2].trim() };
}

// --- Server ---

export class FeedServer {
  private app: express.Express;
  private server: http.Server;
  private wss: WebSocketServer;
  private posts: FeedPost[] = [];
  private dmThreads: Map<string, DMThread> = new Map();
  private onboardingState: OnboardingState | null;
  private provider: FeedServerOptions['provider'];
  private taskQueue: TaskQueue | null;
  private db: FeedDb | null;
  public persistenceStatus: 'ok' | 'degraded' | 'none' = 'none';
  private broadcastSeq = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(private port: number, options?: FeedServerOptions) {
    this.onboardingState = options?.onboardingState ?? null;
    this.provider = options?.provider;
    this.taskQueue = options?.taskQueue ?? null;
    this.db = options?.db ?? null;

    if (this.db) {
      try {
        this.initSchema();
        this.loadFromDb();
        this.persistenceStatus = 'ok';
      } catch (err) {
        console.error('[FeedServer] Failed to initialize SQLite persistence:', err);
        this.persistenceStatus = 'degraded';
      }
    }

    this.app = express();
    this.app.use(express.json({ limit: '6mb' }));

    // --- Request ID middleware ---
    this.app.use((req, res, next) => {
      const requestId = req.headers['x-request-id'] as string || crypto.randomUUID();
      (req as any).requestId = requestId;
      res.setHeader('x-request-id', requestId);
      next();
    });

    // --- Request logging middleware ---
    this.app.use((req, res, next) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        if (duration > 1000 || res.statusCode >= 400) {
          console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms [${(req as any).requestId}]`);
        }
      });
      next();
    });

    this.app.use(express.static(path.join(__dirname, '../client/dist')));

    // Serve uploaded images
    const uploadsDir = path.join(process.cwd(), '.slice', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    this.app.use('/uploads', express.static(uploadsDir));

    const app = this.app;

    // --- API routes ---

    app.get('/api/health', (_req, res) => {
      res.json({
        status: 'ok',
        uptime: process.uptime(),
        components: {
          feed: 'ok',
          websocket: this.wss?.clients?.size !== undefined ? 'ok' : 'error',
          persistence: this.persistenceStatus,
          tasks: this.taskQueue ? 'ok' : 'unavailable',
        },
        connections: this.wss?.clients?.size || 0,
        posts: this.posts.length,
        tasks: this.taskQueue ? {
          open: this.taskQueue.listTasks('open').length,
          inProgress: this.taskQueue.listTasks('in_progress').length,
          completed: this.taskQueue.listTasks('completed').length,
        } : null,
      });
    });

    app.get('/api/feed', (_req, res) => {
      res.json(this.posts.slice().reverse());
    });

    app.post('/api/feed', (req, res) => {
      const { content, agentId, agentName, agentRole, imageBase64, imageAlt, imageUrl: providedImageUrl } = req.body as {
        content?: string;
        agentId?: string;
        agentName?: string;
        agentRole?: string;
        imageBase64?: string;
        imageAlt?: string;
        imageUrl?: string;
      };
      if (!content || typeof content !== 'string' || !content.trim()) {
        res.status(400).json({ error: 'content is required', requestId: (req as any).requestId });
        return;
      }
      if (content.length > 10000) {
        res.status(400).json({ error: 'Post content too long (max 10000 chars)', requestId: (req as any).requestId });
        return;
      }
      const trimmed = content.trim();

      // Handle base64-encoded image upload
      let imageUrl: string | undefined = providedImageUrl;
      if (imageBase64 && typeof imageBase64 === 'string') {
        const id = crypto.randomUUID();
        const ext = imageBase64.startsWith('data:image/png') ? 'png' : 'jpg';
        const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
        const filePath = path.join(uploadsDir, `${id}.${ext}`);
        try {
          fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
          imageUrl = `/uploads/${id}.${ext}`;
        } catch (err) {
          console.error('[FeedServer] Failed to save uploaded image:', err);
        }
      }

      const post = this.addPost({
        content: trimmed,
        agentId,
        agentName: agentName || 'Anonymous',
        agentRole,
        imageUrl,
        imageAlt: imageAlt || undefined,
      });

      // --- @mention detection ---
      const mention = parseMention(trimmed);
      if (mention && this.taskQueue) {
        const targetRole = mention.target;
        const taskDescription = mention.message;

        if (targetRole === 'director') {
          const task = this.taskQueue.createTask(
            taskDescription.slice(0, 80),
            taskDescription,
            { priority: 2 },
          );
          setTimeout(() => {
            this.addPost({
              agentName: 'Director',
              agentRole: 'director',
              content: `Received: "${task.title}"\nTask #${task.id} created and queued for dispatch.`,
            });
            this.broadcast({ type: 'new-post', data: this.posts[this.posts.length - 1] });
          }, 500);
        }

        if (targetRole === 'worker') {
          const task = this.taskQueue.createTask(
            taskDescription.slice(0, 80),
            taskDescription,
            { priority: 3 },
          );
          setTimeout(() => {
            this.addPost({
              agentName: 'Worker',
              agentRole: 'worker',
              content: `Acknowledged. Task #${task.id}: "${task.title}" added to my queue.`,
            });
            this.broadcast({ type: 'new-post', data: this.posts[this.posts.length - 1] });
          }, 500);
        }

        if (targetRole === 'steward') {
          const task = this.taskQueue.createTask(
            taskDescription.slice(0, 80),
            taskDescription,
            { priority: 2 },
          );
          setTimeout(() => {
            this.addPost({
              agentName: 'Steward',
              agentRole: 'steward',
              content: `Review task queued: "${task.title}" (Task #${task.id}). Will inspect and report back.`,
            });
            this.broadcast({ type: 'new-post', data: this.posts[this.posts.length - 1] });
          }, 500);
        }

        if (targetRole === 'all') {
          setTimeout(() => {
            this.addPost({
              agentName: 'Director',
              agentRole: 'director',
              content: `Broadcast received. Triaging: "${taskDescription.slice(0, 100)}"`,
            });
            this.broadcast({ type: 'new-post', data: this.posts[this.posts.length - 1] });
          }, 500);
        }
      }

      res.status(201).json(post);
    });

    app.post('/api/feed/:id/like', (req, res) => {
      const post = this.posts.find((p) => p.id === req.params.id);
      if (!post) {
        res.status(404).json({ error: 'Post not found', requestId: (req as any).requestId });
        return;
      }
      post.likes += 1;
      this.dbRun('UPDATE posts SET likes = ? WHERE id = ?', [post.likes, post.id]);
      this.broadcast({ type: 'reaction', data: { postId: post.id, likes: post.likes } });
      res.json({ likes: post.likes });
    });

    app.post('/api/feed/:id/comments', (req, res) => {
      const post = this.posts.find((p) => p.id === req.params.id);
      if (!post) {
        res.status(404).json({ error: 'post not found' });
        return;
      }
      const { content: commentContent, authorId, authorName } = req.body as {
        content?: string;
        authorId?: string;
        authorName?: string;
      };
      if (!commentContent || typeof commentContent !== 'string' || !commentContent.trim()) {
        res.status(400).json({ error: 'content is required' });
        return;
      }
      const comment: FeedComment = {
        id: crypto.randomUUID(),
        authorId: authorId || 'user',
        authorName: authorName || 'Anonymous',
        content: commentContent.trim(),
        timestamp: new Date().toISOString(),
      };
      post.comments.push(comment);
      this.dbRun('UPDATE posts SET comments = ? WHERE id = ?', [JSON.stringify(post.comments), post.id]);
      this.broadcast({ type: 'new-comment', data: { postId: post.id, comment } });
      res.status(201).json(comment);
    });

    // --- Onboarding routes ---

    app.get('/api/onboarding', (_req, res) => {
      if (!this.onboardingState) {
        res.json({ active: false, state: null });
        return;
      }
      res.json({ active: true, state: this.onboardingState });
    });

    app.post('/api/onboarding/advance', (_req, res) => {
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
        this.saveOnboarding('state', null);
        res.json({ active: false, state: finalState });
        return;
      }
      this.saveOnboarding('state', this.onboardingState);
      res.json({ active: true, state: this.onboardingState });
    });

    app.post('/api/onboarding/skip', (_req, res) => {
      this.onboardingState = null;
      this.saveOnboarding('state', null);
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
        return "Here's my proposed plan:\n\n1. Analyze requirements and scope\n2. Break into subtasks:\n   - Task A: Set up data models\n   - Task B: Implement core logic\n   - Task C: Build UI components\n   - Task D: Integration tests\n3. Assign workers and set priorities\n4. Monitor progress and adjust\n\nShall I create these tasks and assign them?";
      }
      if (lower.includes('status') || lower.includes('progress')) {
        return 'Current status report:\n\n- Active plan: Auth System\n- Tasks completed: 2/4\n- Worker (bob): implementing login form\n- Steward (carol): reviewing PR #42\n- No blockers detected\n\nOverall progress: on track.';
      }
      if (lower.includes('help') || lower.includes('what can')) {
        return "I'm the Director agent. Here's what I can do:\n\n- Plan and break down projects into tasks\n- Assign work to Worker agents\n- Coordinate between Workers and Stewards\n- Report on progress and blockers\n- Reprioritize tasks based on feedback\n\nTry telling me what you want to build, or ask for a status update.";
      }
      return "I'll work on that. Creating tasks...";
    };

    app.get('/api/dm', (_req, res) => {
      const threads = Array.from(this.dmThreads.values()).sort(
        (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
      );
      res.json(threads);
    });

    app.get('/api/dm/:agentName', (req, res) => {
      const thread = getOrCreateDM(req.params.agentName);
      res.json(thread);
    });

    app.post('/api/dm/:agentName', async (req, res) => {
      const { content: dmContent } = req.body as { content?: string };
      if (!dmContent || typeof dmContent !== 'string' || !dmContent.trim()) {
        res.status(400).json({ error: 'content is required' });
        return;
      }
      const agentName = req.params.agentName;
      const thread = getOrCreateDM(agentName);
      const now = new Date().toISOString();

      const userMsg: DMMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: dmContent.trim(),
        timestamp: now,
      };
      thread.messages.push(userMsg);
      thread.lastMessageAt = now;
      this.persistDmMessage(agentName, userMsg);

      // Agent auto-response
      let agentResponse: string;

      if (this.provider) {
        // Use real LLM via OpenRouter
        const systemPrompt = this.getAgentSystemPrompt(agentName);
        const messages = [
          { role: 'system' as const, content: systemPrompt },
          ...thread.messages.map(m => ({
            role: m.role === 'agent' ? 'assistant' as const : 'user' as const,
            content: m.content,
          })),
        ];

        try {
          const result = await this.provider.complete(messages);
          agentResponse = result.content;
        } catch (err: any) {
          agentResponse = `Error connecting to LLM: ${err.message}`;
        }
      } else {
        // Fall back to mock responses
        const isDirector = thread.agentRole === 'director';
        agentResponse = isDirector
          ? generateDirectorResponse(dmContent)
          : 'I received your message. (Agent responses coming in Phase 2)';
      }

      // --- Director AI Planning: parse response for task creation ---
      const agentRole = KNOWN_AGENTS[agentName] || 'system';
      if (agentRole === 'director' && this.taskQueue && agentResponse) {
        const taskLines = agentResponse.match(/^\d+\.\s+\*?\*?(.+?)\*?\*?\s*[-\u2014:]/gm);
        if (taskLines && taskLines.length >= 2) {
          const titles = taskLines.map((line: string) =>
            line.replace(/^\d+\.\s+\*?\*?/, '').replace(/\*?\*?\s*[-\u2014:].*$/, '').trim()
          ).filter((t: string) => t.length > 5);

          if (titles.length > 0) {
            this.taskQueue.createPlan(
              'Plan from Director DM',
              titles,
            );
            agentResponse += '\n\n_Created plan with ' + titles.length + ' tasks. The dispatch daemon will assign them to workers._';
          }
        }
      }

      const agentTimestamp = new Date(Date.now() + 500).toISOString();
      const agentMsg: DMMessage = {
        id: crypto.randomUUID(),
        role: 'agent',
        content: agentResponse,
        timestamp: agentTimestamp,
      };
      thread.messages.push(agentMsg);
      thread.lastMessageAt = agentTimestamp;
      this.persistDmMessage(agentName, agentMsg);

      res.status(201).json({ userMessage: userMsg, agentMessage: agentMsg });
    });

    // --- Status & workspace routes ---

    app.get('/api/status', (_req, res) => {
      const tasks = this.taskQueue?.listTasks() || [];
      const inProgress = tasks.filter(t => t.status === 'in_progress');
      const completed = tasks.filter(t => t.status === 'completed');
      const open = tasks.filter(t => t.status === 'open');

      // Build agent statuses from real task assignments
      const agents: { name: string; role: string; status: string; task?: string }[] = [];
      for (const task of inProgress) {
        if (task.assignedTo) {
          agents.push({
            name: task.assignedTo,
            role: 'worker',
            status: 'working',
            task: task.title,
          });
        }
      }

      // Derive agents from feed posts if no task-based agents
      if (agents.length === 0) {
        const agentNames = new Map<string, { role: string; content: string }>();
        for (const p of this.posts) {
          if (p.agentName && p.agentRole) {
            agentNames.set(p.agentName, { role: p.agentRole, content: p.content });
          }
        }

        for (const [name, info] of agentNames) {
          if (info.role === 'director') {
            agents.push({ name, role: 'director', status: 'idle' });
          } else if (info.role === 'worker') {
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
      }

      // Fallback if still no agents
      if (agents.length === 0) {
        agents.push({ name: 'Director', role: 'director', status: 'idle' });
      }

      res.json({
        agents,
        tasks: {
          open: open.length,
          inProgress: inProgress.length,
          completed: completed.length,
          total: tasks.length,
        },
        activePlan: null,
        repoName: 'pi-slice',
      });
    });

    // --- Task API routes ---

    app.get('/api/tasks', (req, res) => {
      if (!this.taskQueue) {
        res.json([]);
        return;
      }
      const status = req.query.status as string | undefined;
      res.json(this.taskQueue.listTasks(status as TaskStatus | undefined));
    });

    app.post('/api/tasks', (req, res) => {
      if (!this.taskQueue) {
        res.status(503).json({ error: 'Task queue not available' });
        return;
      }
      const { title, description, priority, planId } = req.body as {
        title?: string;
        description?: string;
        priority?: number;
        planId?: string;
      };
      if (!title || typeof title !== 'string' || !title.trim()) {
        res.status(400).json({ error: 'title is required' });
        return;
      }
      const task = this.taskQueue.createTask(
        title.trim(),
        (description || title).trim(),
        { priority: (priority as 1 | 2 | 3 | 4 | 5) || undefined, planId },
      );

      this.addPost({
        agentName: 'Director',
        agentRole: 'director',
        content: `New task created: "${task.title}" (priority ${task.priority})`,
      });

      res.status(201).json(task);
    });

    app.get('/api/tasks/:id', (req, res) => {
      if (!this.taskQueue) {
        res.status(503).json({ error: 'Task queue not available' });
        return;
      }
      const task = this.taskQueue.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: 'task not found' });
        return;
      }
      res.json(task);
    });

    app.post('/api/tasks/:id/complete', (req, res) => {
      if (!this.taskQueue) {
        res.status(503).json({ error: 'Task queue not available' });
        return;
      }
      const task = this.taskQueue.getTask(req.params.id);
      if (!task) {
        res.status(404).json({ error: 'task not found' });
        return;
      }
      const { result } = req.body as { result?: string };
      const completed = this.taskQueue.completeTask(task.id, result || 'Manually completed');
      res.json(completed);
    });

    app.get('/api/plans', (_req, res) => {
      if (!this.taskQueue) {
        res.json([]);
        return;
      }
      res.json(this.taskQueue.listPlans());
    });

    app.post('/api/plans', (req, res) => {
      if (!this.taskQueue) {
        res.status(503).json({ error: 'Task queue not available' });
        return;
      }
      const { title, tasks: taskTitles } = req.body as {
        title?: string;
        tasks?: string[];
      };
      if (!title || typeof title !== 'string' || !title.trim()) {
        res.status(400).json({ error: 'title is required' });
        return;
      }
      if (!taskTitles || !Array.isArray(taskTitles) || taskTitles.length === 0) {
        res.status(400).json({ error: 'tasks array is required' });
        return;
      }
      const plan = this.taskQueue.createPlan(title.trim(), taskTitles);

      this.addPost({
        agentName: 'Director',
        agentRole: 'director',
        content: `New plan created: "${plan.title}" with ${plan.taskIds.length} tasks`,
      });

      res.status(201).json(plan);
    });

    app.get('/api/workspace', (_req, res) => {
      res.json({
        repoName: 'pi-slice',
        branch: 'main',
        dirtyFiles: 0,
      });
    });

    // SPA catch-all
    app.get('*', (req, res) => {
      if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, '../client/dist/index.html'));
      }
    });

    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    this.wss.on('connection', (ws) => {
      // Reject if too many connections
      if (this.wss.clients.size > 100) {
        ws.close(1013, 'Too many connections');
        return;
      }

      // Track liveness for ping/pong heartbeat
      (ws as any).isAlive = true;
      (ws as any).lastActivity = Date.now();

      ws.on('pong', () => {
        (ws as any).isAlive = true;
        (ws as any).lastActivity = Date.now();
      });

      ws.on('message', () => {
        (ws as any).lastActivity = Date.now();
      });

      // Send initial snapshot
      try {
        ws.send(JSON.stringify({ type: 'snapshot', data: this.posts.slice().reverse(), seq: this.broadcastSeq }));
        ws.send(JSON.stringify({ type: 'agent-count', data: 3, seq: this.broadcastSeq }));
      } catch (err) {
        console.warn('Failed to send initial snapshot:', err);
      }
    });

    // Ping/pong heartbeat every 30s to detect dead connections
    this.pingInterval = setInterval(() => {
      const now = Date.now();
      const idleTimeout = 5 * 60 * 1000; // 5 minutes
      for (const ws of this.wss.clients) {
        // Close idle connections
        if (now - ((ws as any).lastActivity || 0) > idleTimeout) {
          ws.terminate();
          continue;
        }
        if (!(ws as any).isAlive) {
          ws.terminate();
          continue;
        }
        (ws as any).isAlive = false;
        ws.ping();
      }
    }, 30000);

    // Clean up ping interval when WSS closes
    this.wss.on('close', () => {
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
    });
  }

  // --- SQLite persistence helpers ---

  private initSchema(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        agent_id TEXT,
        agent_name TEXT,
        agent_role TEXT DEFAULT 'human',
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        likes INTEGER NOT NULL DEFAULT 0,
        comments TEXT NOT NULL DEFAULT '[]',
        image_url TEXT,
        image_alt TEXT
      );

      CREATE TABLE IF NOT EXISTS dm_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_name TEXT NOT NULL,
        msg_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS onboarding (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private loadFromDb(): void {
    // Load posts
    const postRows = this.db!.query<{
      id: string;
      agent_id: string | null;
      agent_name: string | null;
      agent_role: string | null;
      content: string;
      created_at: string;
      likes: number;
      comments: string;
      image_url: string | null;
      image_alt: string | null;
    }>('SELECT * FROM posts ORDER BY created_at ASC');

    for (const row of postRows) {
      let comments: FeedComment[] = [];
      try {
        comments = JSON.parse(row.comments);
      } catch { /* ignore parse errors */ }
      this.posts.push({
        id: row.id,
        agentId: row.agent_id ?? undefined,
        agentName: row.agent_name ?? undefined,
        agentRole: row.agent_role ?? undefined,
        content: row.content,
        timestamp: row.created_at,
        likes: row.likes,
        comments,
        imageUrl: row.image_url ?? undefined,
        imageAlt: row.image_alt ?? undefined,
      });
    }

    // Load DM threads from dm_messages
    const dmRows = this.db!.query<{
      agent_name: string;
      msg_id: string;
      role: string;
      content: string;
      created_at: string;
    }>('SELECT * FROM dm_messages ORDER BY id ASC');

    const KNOWN: Record<string, string> = {
      director: 'director', alice: 'director',
      worker: 'worker', bob: 'worker',
      steward: 'steward', carol: 'steward',
    };

    for (const row of dmRows) {
      let thread = this.dmThreads.get(row.agent_name);
      if (!thread) {
        thread = {
          id: crypto.randomUUID(),
          agentName: row.agent_name,
          agentRole: KNOWN[row.agent_name] || 'system',
          messages: [],
          createdAt: row.created_at,
          lastMessageAt: row.created_at,
        };
        this.dmThreads.set(row.agent_name, thread);
      }
      thread.messages.push({
        id: row.msg_id,
        role: row.role as 'user' | 'agent',
        content: row.content,
        timestamp: row.created_at,
      });
      thread.lastMessageAt = row.created_at;
    }

    // Load onboarding state
    const onbRows = this.db!.query<{ key: string; value: string }>(
      "SELECT * FROM onboarding WHERE key = 'state'",
    );
    if (onbRows.length > 0 && onbRows[0].value !== 'null') {
      try {
        const saved = JSON.parse(onbRows[0].value) as OnboardingState | null;
        if (saved && !this.onboardingState) {
          this.onboardingState = saved;
        }
      } catch { /* ignore */ }
    }

    console.log(`[FeedServer] Restored ${this.posts.length} posts, ${this.dmThreads.size} DM threads from SQLite`);
  }

  private dbRun(sql: string, params?: unknown[]): void {
    if (!this.db) return;
    try {
      this.db.run(sql, params);
    } catch (err) {
      console.error('[FeedServer] SQLite write failed:', err);
      this.persistenceStatus = 'degraded';
    }
  }

  private persistPost(post: FeedPost): void {
    this.dbRun(
      `INSERT OR REPLACE INTO posts (id, agent_id, agent_name, agent_role, content, created_at, likes, comments, image_url, image_alt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [post.id, post.agentId ?? null, post.agentName ?? null, post.agentRole ?? null,
       post.content, post.timestamp, post.likes, JSON.stringify(post.comments),
       post.imageUrl ?? null, post.imageAlt ?? null],
    );
  }

  private persistDmMessage(agentName: string, msg: DMMessage): void {
    this.dbRun(
      'INSERT INTO dm_messages (agent_name, msg_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [agentName, msg.id, msg.role, msg.content, msg.timestamp],
    );
  }

  private saveOnboarding(key: string, value: unknown): void {
    this.dbRun(
      'INSERT OR REPLACE INTO onboarding (key, value) VALUES (?, ?)',
      [key, JSON.stringify(value)],
    );
  }

  /** Get system prompt for an agent based on its role. */
  private getAgentSystemPrompt(agentName: string): string {
    const KNOWN_AGENTS: Record<string, string> = {
      director: 'director',
      alice: 'director',
      worker: 'worker',
      bob: 'worker',
      steward: 'steward',
      carol: 'steward',
    };
    const role = KNOWN_AGENTS[agentName] || 'worker';

    const prompts: Record<string, string> = {
      director: `You are the Director agent in Slice, a social coding agent platform. Your name is "${agentName}".

Your responsibilities:
- Break down user requests into actionable tasks
- Create plans with clear steps
- Coordinate workers and stewards
- Answer questions about the workspace and project status

When the user asks you to build something, respond with a structured plan:
1. Break it into 3-5 concrete tasks
2. Estimate complexity (small/medium/large)
3. Suggest which agent should handle each task

Keep responses concise and actionable. Use markdown formatting.
You're talking to the human workspace owner in a direct message.`,

      worker: `You are a Worker agent in Slice named "${agentName}". You execute coding tasks in isolated git worktrees. You write code, run tests, and commit changes. When asked about your work, describe what you're doing technically. Keep responses focused and code-oriented.`,

      steward: `You are a Steward agent in Slice named "${agentName}". You review PRs, merge branches, scan documentation, and maintain code quality. When asked about your work, focus on code review findings, test results, and merge status.`,
    };

    return prompts[role] || prompts.worker;
  }

  /** Add a post programmatically (for agent use). */
  addPost(post: Omit<FeedPost, 'id' | 'timestamp' | 'likes' | 'comments'>): FeedPost {
    const newPost: FeedPost = {
      id: crypto.randomUUID(),
      agentId: post.agentId,
      agentName: post.agentName,
      agentRole: post.agentRole,
      content: post.content,
      timestamp: new Date().toISOString(),
      likes: 0,
      comments: [],
      imageUrl: post.imageUrl,
      imageAlt: post.imageAlt,
    };
    this.posts.push(newPost);
    this.persistPost(newPost);
    this.broadcast({ type: 'new-post', data: newPost });
    return newPost;
  }

  /** Broadcast a JSON event to all connected WebSocket clients. */
  broadcast(message: Record<string, unknown>): void {
    this.broadcastSeq++;
    const payload = JSON.stringify({ ...message, seq: this.broadcastSeq });

    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload);
        } catch (err) {
          console.warn('WebSocket send failed, terminating client:', err);
          try { client.terminate(); } catch { /* ignore */ }
        }
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
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
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
