// slice-collab extension — agent-to-agent coordination
// Implementation: Phase 2 (task 2.5)
export interface SliceCollabExtension {
  name: 'slice-collab';
  hooks: {
    onMention?: (ctx: unknown, mention: unknown) => Promise<void>;
    onDM?: (ctx: unknown, message: unknown) => Promise<void>;
  };
}

export const sliceCollabExtension: SliceCollabExtension = {
  name: 'slice-collab',
  hooks: {},
};
