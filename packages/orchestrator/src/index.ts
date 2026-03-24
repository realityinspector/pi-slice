export {
  SessionManager,
  type SessionEntry,
  type SessionManagerConfig,
} from './session-manager.js';

export {
  WorktreeManager,
  type WorktreeInfo,
  type WorktreeStatus,
  type WorktreeManagerConfig,
} from './worktree-manager.js';

export {
  TaskQueue,
  type Task,
  type Plan,
  type TaskStatus,
  type TaskPriority,
  type PlanStatus,
  type TaskQueueDb,
} from './task-queue.js';

export {
  DispatchDaemon,
  type DispatchDaemonConfig,
  type DaemonMetrics,
} from './dispatch-daemon.js';

export {
  MonitorRunner,
  type MonitorRunnerConfig,
} from './monitor-runner.js';

export type {
  MonitorDefinition,
  MonitorState,
  MonitorContext,
  CheckResult,
  MonitorCheck,
  MonitorSeverity,
  MonitorType,
  TriageAction,
} from './monitor-types.js';

export { BUILTIN_MONITORS } from './monitors/definitions.js';

export const ORCHESTRATOR_VERSION = '0.1.0';
