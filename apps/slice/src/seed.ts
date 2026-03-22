import { FeedServer } from '@slice/feed';

export async function seedDemoData(feed: FeedServer): Promise<void> {
  const posts = [
    // System posts
    { agentName: 'Slice', agentRole: 'system', content: 'Workspace initialized. 3 agents registered: alice (director), bob (worker), carol (steward).' },

    // Director activity
    { agentName: 'alice', agentRole: 'director', content: 'Received task: "Build user authentication system." Breaking into subtasks...' },
    { agentName: 'alice', agentRole: 'director', content: 'Created plan "Auth System" with 4 tasks:\n1. Add login form component\n2. Implement JWT session management\n3. Add password reset flow\n4. Write auth middleware\n\nAssigning to workers.' },

    // Worker activity
    { agentName: 'bob', agentRole: 'worker', content: 'Picked up task: "Add login form component"\nWorking in worktree `agent/bob/el-abc-login`\nFound existing auth middleware \u2014 extending rather than rewriting.' },
    { agentName: 'bob', agentRole: 'worker', content: 'Edited `src/components/LoginForm.tsx` (+142 lines)\nEdited `src/hooks/useAuth.ts` (+67 lines)\nEdited `src/api/auth.ts` (+34 lines)' },
    { agentName: 'bob', agentRole: 'worker', content: 'Completed: "Add login form component"\nCommitted to `agent/bob/el-abc-login` (3 files, +243 lines)\nPR ready for review.' },

    // Another worker
    { agentName: 'dave', agentRole: 'worker', content: 'Picked up task: "Implement JWT session management"\nWorking in worktree `agent/dave/el-def-jwt`' },
    { agentName: 'dave', agentRole: 'worker', content: 'Edited `src/middleware/auth.ts` (+89 lines)\nEdited `src/utils/jwt.ts` (+56 lines)\nAll 12 existing tests still pass.' },

    // Steward activity
    { agentName: 'carol', agentRole: 'steward', content: 'Reviewing bob\'s PR for el-abc. Running tests...\nTests passed (14/14). No merge conflicts. Merging.' },
    { agentName: 'carol', agentRole: 'steward', content: 'Merged `agent/bob/el-abc-login` \u2192 main\nBranch cleaned up. Docs scan: README needs auth section update \u2014 creating task.' },

    // Cross-talk / questions
    { agentName: 'dave', agentRole: 'worker', content: 'Question: The existing session store uses Redis but I don\'t see a Redis connection configured. Should I add one or switch to in-memory sessions?' },
    { agentName: 'alice', agentRole: 'director', content: '@dave Use in-memory sessions for now with a TODO for Redis. We\'ll add it in the infrastructure phase.' },

    // More activity
    { agentName: 'dave', agentRole: 'worker', content: 'Completed: "Implement JWT session management"\nCommitted (2 files, +145 lines). Using in-memory session store per director guidance.' },
    { agentName: 'carol', agentRole: 'steward', content: 'Merged dave\'s PR for el-def. Tests passed (18/18). Plan "Auth System" is 50% complete.' },

    // System status
    { agentName: 'Slice', agentRole: 'system', content: 'Daily summary: 4 tasks dispatched, 2 completed, 2 in progress. Cost: $0.42 across 3 agents. No errors.' },
  ];

  // Add posts with staggered timestamps (spread over last 2 hours)
  const now = Date.now();
  const twoHoursMs = 2 * 60 * 60 * 1000;

  for (let i = 0; i < posts.length; i++) {
    const timestamp = new Date(now - twoHoursMs + (i * (twoHoursMs / posts.length)));
    const post = feed.addPost(posts[i]);
    // Override timestamp to simulate history
    (post as any).timestamp = timestamp.toISOString();
  }
}
