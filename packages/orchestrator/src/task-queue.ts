/**
 * TaskQueue — in-memory task queue for dispatch.
 */

import { randomUUID } from 'node:crypto';

export type TaskStatus = 'open' | 'assigned' | 'in_progress' | 'completed' | 'failed';
export type TaskPriority = 1 | 2 | 3 | 4 | 5; // 1 = highest

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
}

export interface Plan {
  id: string;
  title: string;
  taskIds: string[];
  status: 'draft' | 'active' | 'completed';
  createdAt: string;
}

export class TaskQueue {
  private tasks = new Map<string, Task>();
  private plans = new Map<string, Plan>();

  /**
   * Create a new task and add it to the queue.
   */
  createTask(
    title: string,
    description: string,
    options?: { priority?: TaskPriority; planId?: string },
  ): Task {
    const task: Task = {
      id: randomUUID(),
      title,
      description,
      status: 'open',
      priority: options?.priority ?? 3,
      createdAt: new Date().toISOString(),
      planId: options?.planId,
    };
    this.tasks.set(task.id, task);
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
   * Assign a task to a named agent.
   */
  assignTask(taskId: string, agentName: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    task.status = 'assigned';
    task.assignedTo = agentName;
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
   * Check whether all tasks in a plan are completed, and if so mark the plan as completed.
   */
  private checkPlanCompletion(planId: string): void {
    const plan = this.plans.get(planId);
    if (!plan || plan.status !== 'active') return;

    const allDone = plan.taskIds.every((id) => {
      const t = this.tasks.get(id);
      return t && (t.status === 'completed' || t.status === 'failed');
    });

    if (allDone) {
      plan.status = 'completed';
    }
  }
}
