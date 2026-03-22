/**
 * DispatchDaemon — polls the task queue and spawns worker agents to execute tasks.
 */

import { TaskQueue, Task } from './task-queue.js';
import type { AgentSpawner, AgentSession } from '@slice/pi-bridge';

export interface DispatchDaemonConfig {
  maxWorkers: number;
  pollIntervalMs: number; // default 5000
  workerModel?: string;
  workerTimeoutMs?: number; // default 300000 (5 minutes)
  onTaskAssigned?: (task: Task, agentName: string) => void;
  onTaskCompleted?: (task: Task) => void;
  onTaskFailed?: (task: Task) => void;
  onTaskRetried?: (task: Task, attempt: number) => void;
  onAgentMessage?: (agentName: string, message: string) => void;
}

export interface DaemonMetrics {
  isRunning: boolean;
  activeWorkers: number;
  maxWorkers: number;
  totalDispatched: number;
  totalCompleted: number;
  totalFailed: number;
  totalRetried: number;
  uptimeMs: number;
}

interface ActiveWorker {
  session: AgentSession;
  task: Task;
  startedAt: number;
}

export class DispatchDaemon {
  private running = false;
  private pollInProgress = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeWorkers = new Map<string, ActiveWorker>();
  private workerCounter = 0;
  private workerTimeoutMs: number;
  private startedAt = 0;

  // Metrics counters
  private totalDispatched = 0;
  private totalCompleted = 0;
  private totalFailed = 0;
  private totalRetried = 0;

  constructor(
    private queue: TaskQueue,
    private spawner: AgentSpawner,
    private config: DispatchDaemonConfig,
  ) {
    this.workerTimeoutMs = config.workerTimeoutMs ?? 300000; // 5 minutes
  }

  /**
   * Start the dispatch loop.
   */
  start(): void {
    this.running = true;
    this.startedAt = Date.now();
    this.poll(); // immediate first poll
    this.pollTimer = setInterval(() => this.poll(), this.config.pollIntervalMs);
    console.log(
      `Dispatch daemon started (max ${this.config.maxWorkers} workers, poll every ${this.config.pollIntervalMs}ms)`,
    );
  }

  /**
   * Poll the queue for work and manage active workers.
   * Guarded against overlapping polls and wrapped in try/catch for resilience.
   */
  private async poll(): Promise<void> {
    if (!this.running || this.pollInProgress) return;
    this.pollInProgress = true;

    try {
      // Check for timed-out workers
      for (const [name, worker] of this.activeWorkers) {
        if (Date.now() - worker.startedAt > this.workerTimeoutMs) {
          console.warn(`Worker ${name} timed out on task ${worker.task.id}`);
          worker.session.close();
          this.queue.failTask(worker.task.id, 'Worker timed out after 5 minutes');
          this.totalFailed += 1;
          this.config.onTaskFailed?.(this.queue.getTask(worker.task.id)!);
          this.activeWorkers.delete(name);
          // Attempt retry for timed-out tasks
          this.scheduleRetry(worker.task.id);
        }
      }

      // Clean up completed workers
      for (const [name, worker] of this.activeWorkers) {
        if (worker.session.status === 'closed') {
          this.activeWorkers.delete(name);
        }
      }

      // Assign tasks while we have capacity (using atomic claimNextTask)
      while (this.activeWorkers.size < this.config.maxWorkers) {
        this.workerCounter += 1;
        const workerName = `worker-${this.workerCounter}`;
        const task = this.queue.claimNextTask(workerName);
        if (!task) {
          // Undo the counter bump since no task was claimed
          this.workerCounter -= 1;
          break;
        }

        this.totalDispatched += 1;
        this.config.onTaskAssigned?.(task, workerName);

        // Spawn worker agent (fire-and-forget; errors are caught inside spawnWorker)
        this.spawnWorker(workerName, task);
      }
    } catch (err) {
      console.error('Dispatch daemon poll error:', err);
    } finally {
      this.pollInProgress = false;
    }
  }

  /**
   * Spawn a worker agent session to execute a task.
   */
  private async spawnWorker(name: string, task: Task): Promise<void> {
    try {
      this.queue.startTask(task.id);

      const model = this.config.workerModel ?? 'anthropic/claude-sonnet-4';

      const session = await this.spawner.spawn({
        agentId: name,
        model,
        systemPrompt: `You are a worker agent named "${name}" in Slice. You execute coding tasks.
Your current task: "${task.title}"
Description: ${task.description}

Complete the task and report what you did. Be specific about files changed and actions taken.
Respond with a clear summary of what you accomplished.`,
      });

      this.activeWorkers.set(name, { session, task, startedAt: Date.now() });

      // Send the task to the agent and get response
      const response = await session.send(
        `Execute this task: ${task.title}\n\n${task.description}`,
      );

      // Task completed successfully
      this.queue.completeTask(task.id, response);
      this.totalCompleted += 1;
      this.config.onTaskCompleted?.(this.queue.getTask(task.id)!);
      this.config.onAgentMessage?.(name, response);

      session.close();
      this.activeWorkers.delete(name);
    } catch (err: any) {
      this.queue.failTask(task.id, err.message);
      this.totalFailed += 1;
      this.config.onTaskFailed?.(this.queue.getTask(task.id)!);
      this.config.onAgentMessage?.(name, `Task failed: ${err.message}`);
      this.activeWorkers.delete(name);

      // Attempt retry
      this.scheduleRetry(task.id);
    }
  }

  /**
   * Schedule a retry for a failed task with exponential backoff (5s, 15s, 45s).
   */
  private scheduleRetry(taskId: string): void {
    const task = this.queue.getTask(taskId);
    if (!task) return;

    const retried = this.queue.retryTask(taskId);
    if (retried) {
      this.totalRetried += 1;
      const delayMs = 5000 * Math.pow(3, retried.retries - 1); // 5s, 15s, 45s
      console.log(
        `Scheduling retry ${retried.retries}/${retried.maxRetries} for task ${taskId} in ${delayMs}ms`,
      );
      this.config.onTaskRetried?.(retried, retried.retries);

      // After the delay, the next poll will pick it up since status is back to 'open'
      // We use setTimeout to delay resetting so the task doesn't get immediately reclaimed
      // (retryTask already set it to 'open', so we temporarily hold it)
      // Actually retryTask already reset it — the next poll will pick it up.
      // For exponential backoff, temporarily mark it so it isn't grabbed instantly.
      retried.status = 'assigned'; // hold it briefly
      retried.assignedTo = '__retry_pending__';
      setTimeout(() => {
        const t = this.queue.getTask(taskId);
        if (t && t.assignedTo === '__retry_pending__') {
          t.status = 'open';
          t.assignedTo = undefined;
        }
      }, delayMs);
    }
  }

  /**
   * Stop the dispatch loop and close all active worker sessions.
   */
  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const [, worker] of this.activeWorkers) {
      worker.session.close();
    }
    this.activeWorkers.clear();
    console.log('Dispatch daemon stopped.');
  }

  /** Number of currently active workers. */
  get workerCount(): number {
    return this.activeWorkers.size;
  }

  /** Whether the daemon is running. */
  get isRunning(): boolean {
    return this.running;
  }

  /** Get operational metrics for the daemon. */
  getMetrics(): DaemonMetrics {
    return {
      isRunning: this.running,
      activeWorkers: this.activeWorkers.size,
      maxWorkers: this.config.maxWorkers,
      totalDispatched: this.totalDispatched,
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
      totalRetried: this.totalRetried,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }
}
