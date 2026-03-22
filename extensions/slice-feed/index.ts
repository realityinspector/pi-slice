// slice-feed extension — posts agent activity to the social feed
// Implementation: Phase 2 (task 2.2)
export interface SliceFeedExtension {
  name: 'slice-feed';
  hooks: {
    onToolExecution?: (ctx: unknown, tool: unknown, result: unknown) => Promise<void>;
    onTaskComplete?: (ctx: unknown, task: unknown) => Promise<void>;
    onTaskStart?: (ctx: unknown, task: unknown) => Promise<void>;
    onError?: (ctx: unknown, error: unknown) => Promise<void>;
  };
}

export const sliceFeedExtension: SliceFeedExtension = {
  name: 'slice-feed',
  hooks: {},
};
