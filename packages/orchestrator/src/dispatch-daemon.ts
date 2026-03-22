/**
 * DispatchDaemon — polls the task queue and spawns worker agents to execute tasks.
 */

import { TaskQueue, Task } from './task-queue.js';
import type { AgentSpawner, AgentSession } from '@slice/pi-bridge';

export interface DispatchDaemonConfig {
  maxWorkers: number;
  pollIntervalMs: number; // default 5000
  workerModel?: string;
  onTaskAssigned?: (task: Task, agentName: string) => void;
  onTaskCompleted?: (task: Task) => void;
  onTaskFailed?: (task: Task) => void;
  onAgentMessage?: (agentName: string, message: string) => void;
}

export class DispatchDaemon {
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private activeWorkers = new Map<string, { session: AgentSession; task: Task }>();
  private workerCounter = 0;

  constructor(
    private queue: TaskQueue,
    private spawner: AgentSpawner,
    private config: DispatchDaemonConfig,
  ) {}

  /**
   * Start the dispatch loop.
   */
  start(): void {
    this.running = true;
    this.poll(); // immediate first poll
    this.pollTimer = setInterval(() => this.poll(), this.config.pollIntervalMs);
    console.log(
      `Dispatch daemon started (max ${this.config.maxWorkers} workers, poll every ${this.config.pollIntervalMs}ms)`,
    );
  }

  /**
   * Poll the queue for work and manage active workers.
   */
  private async poll(): Promise<void> {
    if (!this.running) return;

    // Clean up completed workers
    for (const [name, worker] of this.activeWorkers) {
      if (worker.session.status === 'closed') {
        this.activeWorkers.delete(name);
      }
    }

    // Assign tasks while we have capacity
    while (this.activeWorkers.size < this.config.maxWorkers) {
      const task = this.queue.getNextTask();
      if (!task) break;

      this.workerCounter += 1;
      const workerName = `worker-${this.workerCounter}`;
      this.queue.assignTask(task.id, workerName);
      this.config.onTaskAssigned?.(task, workerName);

      // Spawn worker agent (fire-and-forget; errors are caught inside)
      this.spawnWorker(workerName, task);
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

      this.activeWorkers.set(name, { session, task });

      // Send the task to the agent and get response
      const response = await session.send(
        `Execute this task: ${task.title}\n\n${task.description}`,
      );

      // Task completed successfully
      this.queue.completeTask(task.id, response);
      this.config.onTaskCompleted?.(this.queue.getTask(task.id)!);
      this.config.onAgentMessage?.(name, response);

      session.close();
      this.activeWorkers.delete(name);
    } catch (err: any) {
      this.queue.failTask(task.id, err.message);
      this.config.onTaskFailed?.(this.queue.getTask(task.id)!);
      this.config.onAgentMessage?.(name, `Task failed: ${err.message}`);
      this.activeWorkers.delete(name);
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
}
