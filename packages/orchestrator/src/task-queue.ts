/**
 * TaskQueue — in-memory task queue for dispatch with optional SQLite persistence.
 */

import { randomUUID } from 'node:crypto';

export type TaskStatus = 'open' | 'assigned' | 'in_progress' | 'completed' | 'failed';
export type TaskPriority = 1 | 2 | 3 | 4 | 5; // 1 = highest
export type PlanStatus = 'draft' | 'active' | 'completed' | 'completed_with_failures' | 'failed';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedTo?: string; // agent name
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  error?: string;
  planId?: string;
  retries: number;
  maxRetries: number;
}

export interface Plan {
  id: string;
  title: string;
  taskIds: string[];
  status: PlanStatus;
  createdAt: string;
}

/**
 * Minimal DB interface matching StorageBackend's core methods.
 * Allows any compatible SQLite wrapper to be passed in.
 */
export interface TaskQueueDb {
  exec(sql: string): void;
  run(sql: string, params?: unknown[]): { changes: number };
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
}

export class TaskQueue {
  private tasks = new Map<string, Task>();
  private plans = new Map<string, Plan>();
  private db: TaskQueueDb | null;
  public persistenceStatus: 'ok' | 'degraded' | 'none' = 'none';

  constructor(db?: TaskQueueDb) {
    this.db = db ?? null;
    if (this.db) {
      try {
        this.initSchema();
        this.loadFromDb();
        this.persistenceStatus = 'ok';
      } catch (err) {
        console.error('[TaskQueue] Failed to initialize SQLite persistence:', err);
        this.persistenceStatus = 'degraded';
      }
    }
  }

  private initSchema(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        priority INTEGER NOT NULL DEFAULT 3,
        assigned_to TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        result TEXT,
        error TEXT,
        plan_id TEXT,
        retries INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 3
      );

      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plan_tasks (
        plan_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        PRIMARY KEY (plan_id, task_id)
      );
    `);
  }

  private loadFromDb(): void {
    const taskRows = this.db!.query<{
      id: string;
      title: string;
      description: string;
      status: string;
      priority: number;
      assigned_to: string | null;
      created_at: string;
      started_at: string | null;
      completed_at: string | null;
      result: string | null;
      error: string | null;
      plan_id: string | null;
      retries: number;
      max_retries: number;
    }>('SELECT * FROM tasks');
    for (const row of taskRows) {
      const task: Task = {
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status as TaskStatus,
        priority: row.priority as TaskPriority,
        assignedTo: row.assigned_to ?? undefined,
        createdAt: row.created_at,
        startedAt: row.started_at ?? undefined,
        completedAt: row.completed_at ?? undefined,
        result: row.result ?? undefined,
        error: row.error ?? undefined,
        planId: row.plan_id ?? undefined,
        retries: row.retries ?? 0,
        maxRetries: row.max_retries ?? 3,
      };
      this.tasks.set(task.id, task);
    }

    const planRows = this.db!.query<{
      id: string;
      title: string;
      status: string;
      created_at: string;
    }>('SELECT * FROM plans');
    for (const row of planRows) {
      const ptRows = this.db!.query<{ task_id: string }>(
        'SELECT task_id FROM plan_tasks WHERE plan_id = ?',
        [row.id],
      );
      const plan: Plan = {
        id: row.id,
        title: row.title,
        status: row.status as PlanStatus,
        taskIds: ptRows.map((r) => r.task_id),
        createdAt: row.created_at,
      };
      this.plans.set(plan.id, plan);
    }

    console.log(`[TaskQueue] Restored ${this.tasks.size} tasks and ${this.plans.size} plans from SQLite`);
  }

  /** Reload all data from SQLite into memory. */
  restore(): void {
    if (!this.db) return;
    this.tasks.clear();
    this.plans.clear();
    try {
      this.loadFromDb();
      this.persistenceStatus = 'ok';
    } catch (err) {
      console.error('[TaskQueue] restore() failed:', err);
      this.persistenceStatus = 'degraded';
    }
  }

  private dbRun(sql: string, params?: unknown[]): void {
    if (!this.db) return;
    try {
      this.db.run(sql, params);
    } catch (err) {
      console.error('[TaskQueue] SQLite write failed:', err);
      this.persistenceStatus = 'degraded';
    }
  }

  /**
   * Create a new task and add it to the queue.
   */
  createTask(
    title: string,
    description: string,
    options?: { priority?: TaskPriority; planId?: string; maxRetries?: number },
  ): Task {
    const task: Task = {
      id: randomUUID(),
      title,
      description,
      status: 'open',
      priority: options?.priority ?? 3,
      createdAt: new Date().toISOString(),
      planId: options?.planId,
      retries: 0,
      maxRetries: options?.maxRetries ?? 3,
    };
    this.tasks.set(task.id, task);

    this.dbRun(
      `INSERT INTO tasks (id, title, description, status, priority, assigned_to, created_at, started_at, completed_at, result, error, plan_id, retries, max_retries)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [task.id, task.title, task.description, task.status, task.priority, task.assignedTo ?? null,
       task.createdAt, task.startedAt ?? null, task.completedAt ?? null, task.result ?? null,
       task.error ?? null, task.planId ?? null, task.retries, task.maxRetries],
    );

    return task;
  }

  /**
   * Create a plan with multiple tasks.
   */
  createPlan(title: string, taskTitles: string[]): Plan {
    const planId = randomUUID();
    const taskIds: string[] = [];

    for (const taskTitle of taskTitles) {
      const task = this.createTask(taskTitle, taskTitle, { planId });
      taskIds.push(task.id);
    }

    const plan: Plan = {
      id: planId,
      title,
      taskIds,
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    this.plans.set(plan.id, plan);

    this.dbRun(
      'INSERT INTO plans (id, title, status, created_at) VALUES (?, ?, ?, ?)',
      [plan.id, plan.title, plan.status, plan.createdAt],
    );
    for (const taskId of taskIds) {
      this.dbRun(
        'INSERT INTO plan_tasks (plan_id, task_id) VALUES (?, ?)',
        [plan.id, taskId],
      );
    }

    return plan;
  }

  /**
   * Get the highest-priority open task.
   */
  getNextTask(): Task | null {
    let best: Task | null = null;
    for (const task of this.tasks.values()) {
      if (task.status !== 'open') continue;
      if (!best || task.priority < best.priority) {
        best = task;
      }
    }
    return best;
  }

  /**
   * Atomically claim the highest-priority open task for the given agent.
   * Combines getNextTask + assignTask into one operation to prevent double-assignment.
   */
  claimNextTask(agentName: string): Task | null {
    const task = this.getNextTask();
    if (!task) return null;
    task.status = 'assigned';
    task.assignedTo = agentName;

    this.dbRun(
      'UPDATE tasks SET status = ?, assigned_to = ? WHERE id = ?',
      [task.status, task.assignedTo, task.id],
    );

    return task;
  }

  /**
   * Assign a task to a named agent.
   */
  assignTask(taskId: string, agentName: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    task.status = 'assigned';
    task.assignedTo = agentName;

    this.dbRun(
      'UPDATE tasks SET status = ?, assigned_to = ? WHERE id = ?',
      [task.status, task.assignedTo, task.id],
    );

    return task;
  }

  /**
   * Mark a task as in-progress.
   */
  startTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    task.status = 'in_progress';
    task.startedAt = new Date().toISOString();

    this.dbRun(
      'UPDATE tasks SET status = ?, started_at = ? WHERE id = ?',
      [task.status, task.startedAt, task.id],
    );

    return task;
  }

  /**
   * Mark a task as completed with a result.
   */
  completeTask(taskId: string, result: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    task.status = 'completed';
    task.result = result;
    task.completedAt = new Date().toISOString();

    this.dbRun(
      'UPDATE tasks SET status = ?, result = ?, completed_at = ? WHERE id = ?',
      [task.status, task.result, task.completedAt, task.id],
    );

    // Check if the plan is now complete
    if (task.planId) {
      this.checkPlanCompletion(task.planId);
    }

    return task;
  }

  /**
   * Mark a task as failed with an error message.
   */
  failTask(taskId: string, error: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    task.status = 'failed';
    task.error = error;
    task.completedAt = new Date().toISOString();

    this.dbRun(
      'UPDATE tasks SET status = ?, error = ?, completed_at = ? WHERE id = ?',
      [task.status, task.error, task.completedAt, task.id],
    );

    // Check if the plan is now complete
    if (task.planId) {
      this.checkPlanCompletion(task.planId);
    }

    return task;
  }

  /**
   * Retry a failed task — resets status to 'open' and increments retry counter.
   * Returns the task if retried, or null if max retries exceeded.
   */
  retryTask(taskId: string): Task | null {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    if (task.retries >= task.maxRetries) return null;
    task.retries += 1;
    task.status = 'open';
    task.assignedTo = undefined;
    task.error = undefined;
    task.completedAt = undefined;
    task.startedAt = undefined;

    this.dbRun(
      'UPDATE tasks SET status = ?, assigned_to = NULL, error = NULL, completed_at = NULL, started_at = NULL, retries = ? WHERE id = ?',
      [task.status, task.retries, task.id],
    );

    return task;
  }

  /**
   * Get a task by ID.
   */
  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * List tasks, optionally filtered by status.
   */
  listTasks(status?: TaskStatus): Task[] {
    const all = Array.from(this.tasks.values());
    if (!status) return all;
    return all.filter((t) => t.status === status);
  }

  /**
   * Get a plan by ID.
   */
  getPlan(planId: string): Plan | undefined {
    return this.plans.get(planId);
  }

  /**
   * List all plans.
   */
  listPlans(): Plan[] {
    return Array.from(this.plans.values());
  }

  /**
   * Check whether all tasks in a plan are done, and update plan status accordingly.
   * - 'completed' if all tasks succeeded
   * - 'completed_with_failures' if all done but some failed
   * - 'failed' if ALL tasks failed
   */
  private checkPlanCompletion(planId: string): void {
    const plan = this.plans.get(planId);
    if (!plan || plan.status === 'completed' || plan.status === 'failed') return;

    const tasks = plan.taskIds.map((id) => this.tasks.get(id)).filter(Boolean) as Task[];
    const allDone = tasks.every((t) => t.status === 'completed' || t.status === 'failed');

    if (allDone) {
      const allFailed = tasks.every((t) => t.status === 'failed');
      const anyFailed = tasks.some((t) => t.status === 'failed');

      if (allFailed) {
        plan.status = 'failed';
      } else if (anyFailed) {
        plan.status = 'completed_with_failures';
      } else {
        plan.status = 'completed';
      }

      this.dbRun(
        'UPDATE plans SET status = ? WHERE id = ?',
        [plan.status, plan.id],
      );
    }
  }
}
