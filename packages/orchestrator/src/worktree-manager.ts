/**
 * WorktreeManager — manages git worktree lifecycle for agent task isolation.
 *
 * Each worker agent operates in its own git worktree, ensuring:
 * - Parallel agents don't interfere with each other's work
 * - Each task gets a clean, isolated git working directory
 * - Worktrees are cleaned up when tasks complete
 *
 * This is a Phase 1 stub. Full worktree lifecycle management (create, cleanup,
 * branch tracking, health checks) will be implemented in Phase 2.
 */

// ── Types ───────────────────────────────────────────────────────────────────

/** Status of a managed worktree */
export type WorktreeStatus = 'creating' | 'active' | 'cleaning' | 'removed' | 'error';

/** Information about a managed worktree */
export interface WorktreeInfo {
  /** Unique identifier for this worktree entry */
  id: string;
  /** Absolute path to the worktree directory */
  path: string;
  /** Git branch name used by this worktree */
  branch: string;
  /** Agent ID assigned to this worktree */
  agentId: string;
  /** Task ID this worktree was created for */
  taskId?: string;
  /** Current status */
  status: WorktreeStatus;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last status update */
  updatedAt: string;
}

/** Configuration for the worktree manager */
export interface WorktreeManagerConfig {
  /** Root directory where worktrees are created (e.g. .stoneforge/.worktrees) */
  worktreeRoot: string;
  /** Base branch to create worktrees from (default: 'main') */
  baseBranch?: string;
  /** Maximum number of concurrent worktrees */
  maxWorktrees?: number;
}

// ── Manager ─────────────────────────────────────────────────────────────────

export class WorktreeManager {
  private worktrees = new Map<string, WorktreeInfo>();
  private config: Required<WorktreeManagerConfig>;

  constructor(config: WorktreeManagerConfig) {
    this.config = {
      baseBranch: 'main',
      maxWorktrees: 10,
      ...config,
    };
  }

  /**
   * Create a new worktree for an agent.
   * Phase 1 stub: registers the worktree in memory only.
   * Phase 2 will run `git worktree add` and set up the branch.
   */
  async create(agentId: string, branch: string, taskId?: string): Promise<WorktreeInfo> {
    if (this.worktrees.size >= this.config.maxWorktrees) {
      throw new Error(
        `Maximum worktree limit (${this.config.maxWorktrees}) reached. ` +
        `Clean up existing worktrees before creating new ones.`,
      );
    }

    const id = `wt-${agentId}-${Date.now()}`;
    const worktreePath = `${this.config.worktreeRoot}/${agentId}`;
    const now = new Date().toISOString();

    const info: WorktreeInfo = {
      id,
      path: worktreePath,
      branch,
      agentId,
      taskId,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    this.worktrees.set(id, info);
    return info;
  }

  /**
   * Remove a worktree and clean up its branch.
   * Phase 1 stub: removes from memory only.
   * Phase 2 will run `git worktree remove` and optionally delete the branch.
   */
  async remove(worktreeId: string): Promise<void> {
    const info = this.worktrees.get(worktreeId);
    if (!info) {
      throw new Error(`Worktree ${worktreeId} not found`);
    }

    info.status = 'removed';
    info.updatedAt = new Date().toISOString();
    this.worktrees.delete(worktreeId);
  }

  /**
   * Get worktree info by ID.
   */
  get(worktreeId: string): WorktreeInfo | undefined {
    return this.worktrees.get(worktreeId);
  }

  /**
   * Get worktree for a specific agent.
   */
  getByAgent(agentId: string): WorktreeInfo | undefined {
    for (const info of this.worktrees.values()) {
      if (info.agentId === agentId && info.status === 'active') {
        return info;
      }
    }
    return undefined;
  }

  /**
   * Get all tracked worktrees.
   */
  getAll(): WorktreeInfo[] {
    return Array.from(this.worktrees.values());
  }

  /**
   * Get count of active worktrees.
   */
  getActiveCount(): number {
    let count = 0;
    for (const info of this.worktrees.values()) {
      if (info.status === 'active') count++;
    }
    return count;
  }

  /**
   * Clean up all worktrees (e.g. on system shutdown).
   * Phase 1 stub: clears the in-memory map.
   */
  async cleanupAll(): Promise<void> {
    for (const info of this.worktrees.values()) {
      info.status = 'removed';
      info.updatedAt = new Date().toISOString();
    }
    this.worktrees.clear();
  }
}
