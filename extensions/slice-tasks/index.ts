// slice-tasks extension — task CRUD from agent context
// Implementation: Phase 2 (task 2.3)
export interface SliceTasksExtension {
  name: 'slice-tasks';
  hooks: {
    onTaskAssigned?: (ctx: unknown, task: unknown) => Promise<void>;
    onTaskCompleted?: (ctx: unknown, task: unknown) => Promise<void>;
  };
}

export const sliceTasksExtension: SliceTasksExtension = {
  name: 'slice-tasks',
  hooks: {},
};
