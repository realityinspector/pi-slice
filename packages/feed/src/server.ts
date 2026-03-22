import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
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

export interface FeedServerOptions {
  onboardingState?: OnboardingState | null;
  provider?: { complete: (messages: any[], options?: any) => Promise<{ content: string; usage: any }> };
  taskQueue?: TaskQueue;
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
  private provider: FeedServerOptions['provider'];
  private taskQueue: TaskQueue | null;

  constructor(private port: number, options?: FeedServerOptions) {
    this.onboardingState = options?.onboardingState ?? null;
    this.provider = options?.provider;
    this.taskQueue = options?.taskQueue ?? null;
    this.app = express();
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, '../client/dist')));

    const app = this.app;

    // --- API routes ---

    app.get('/api/health', (_req, res) => {
      res.json({ status: 'ok', uptime: process.uptime() });
    });

    app.get('/api/feed', (_req, res) => {
      res.json(this.posts.slice().reverse());
    });

    app.post('/api/feed', (req, res) => {
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
      const trimmed = content.trim();
      const post = this.addPost({
        content: trimmed,
        agentId,
        agentName: agentName || 'Anonymous',
        agentRole,
      });

      // --- @mention detection ---
      const mentionMatch = trimmed.match(/@(director|worker|steward|all)\s+(.+)/i);
      if (mentionMatch && this.taskQueue) {
        const targetRole = mentionMatch[1].toLowerCase();
        const taskDescription = mentionMatch[2].trim();

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
        res.status(404).json({ error: 'post not found' });
        return;
      }
      post.likes += 1;
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
        res.json({ active: false, state: finalState });
        return;
      }
      res.json({ active: true, state: this.onboardingState });
    });

    app.post('/api/onboarding/skip', (_req, res) => {
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
            agentResponse += `\n\n_Created plan with ${titles.length} tasks. The dispatch daemon will assign them to workers._`;
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
      ws.send(JSON.stringify({ type: 'snapshot', data: this.posts.slice().reverse() }));
      ws.send(JSON.stringify({ type: 'agent-count', data: 3 }));
    });
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
