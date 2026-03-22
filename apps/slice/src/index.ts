import { loadConfig } from './config.js';
import { runSetupWizard } from './wizard.js';
import { FeedServer } from '@slice/feed';
import type { OnboardingState } from '@slice/feed';
import { SlicePiProvider, AgentSpawner } from '@slice/pi-bridge';
import { TaskQueue, DispatchDaemon } from '@slice/orchestrator';
import { PeerBridge } from '@slice/federation';
import { getInitialState } from './onboarding.js';
import { scanRepo } from './repo-scanner.js';
import { generateRepoReport } from './repo-report.js';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  console.log('Starting Slice...');

  // 1. Load configuration
  const config = loadConfig();

  // 2. Ensure data directory exists
  fs.mkdirSync(config.dataDir, { recursive: true });

  // 3. Check if first run (config.json doesn't exist in dataDir)
  const configPath = path.join(config.dataDir, 'config.json');
  const isFirstRun = !fs.existsSync(configPath);

  // 4. Initialize provider and spawner
  const provider = new SlicePiProvider({ openrouterApiKey: config.openrouterApiKey });
  const spawner = new AgentSpawner(provider);

  // 5. Initialize task queue and dispatch daemon
  const taskQueue = new TaskQueue();

  // 6. Determine onboarding state and start feed server
  let onboardingState: OnboardingState | null = null;
  if (isFirstRun) {
    onboardingState = getInitialState();
    onboardingState.selectedModels = {
      director: config.directorModel,
      worker: config.workerModel,
      steward: config.stewardModel,
    };
  }

  const feed = new FeedServer(config.port, { onboardingState, provider, taskQueue });
  await feed.start();

  // 7. Create dispatch daemon with feed integration
  const daemon = new DispatchDaemon(taskQueue, spawner, {
    maxWorkers: config.maxWorkers,
    pollIntervalMs: 5000,
    workerModel: config.workerModel,
    onTaskAssigned: (task, agent) => {
      feed.addPost({
        agentName: agent,
        agentRole: 'worker',
        content: `Picked up task: "${task.title}"`,
      });
    },
    onTaskCompleted: (task) => {
      feed.addPost({
        agentName: task.assignedTo || 'worker',
        agentRole: 'worker',
        content: `Completed: "${task.title}"\n\n${task.result?.slice(0, 500) || ''}`,
      });
    },
    onTaskFailed: (task) => {
      feed.addPost({
        agentName: task.assignedTo || 'worker',
        agentRole: 'worker',
        content: `Failed: "${task.title}"\nError: ${task.error}`,
      });
    },
  });

  // 8. Run wizard if first run (feed is available for welcome posts)
  if (isFirstRun) {
    const wizardResult = await runSetupWizard(config, feed);
    fs.writeFileSync(configPath, JSON.stringify(wizardResult, null, 2));
    console.log('Setup complete. Configuration saved.');
  }

  // 8b. Scan the repo we're in and generate a report
  const repoInfo = await scanRepo(process.cwd());
  if (repoInfo && isFirstRun) {
    await generateRepoReport(feed, repoInfo);
    console.log(`Scanned repo: ${repoInfo.name} (${repoInfo.fileCount} files)`);
  }

  // 8c. Seed demo data if requested or first run
  if (config.seedDemo || isFirstRun) {
    const { seedDemoData } = await import('./seed.js');
    await seedDemoData(feed);
    console.log('Demo data seeded.');
  }

  // 9. Start peer bridge for multi-workspace federation
  const bridge = new PeerBridge({
    workspaceName: repoInfo?.name || 'slice',
    workspacePort: config.port,
    brokerPort: 7899,
    onMessage: (msg) => {
      // Inject cross-workspace messages into the feed
      feed.addPost({
        agentName: `${msg.fromName}`,
        agentRole: 'system',
        content: `[cross-workspace] ${msg.content}`,
      });
    },
  });
  await bridge.start();

  // 10. Start the dispatch daemon
  daemon.start();

  // 11. Post startup message
  feed.addPost({
    agentName: 'Slice',
    agentRole: 'system',
    content: `Slice is running. Feed available at http://localhost:${config.port}`,
  });

  console.log(`Slice is running at http://localhost:${config.port}`);
  console.log(`Data directory: ${config.dataDir}`);
  console.log(`Auth token: ${config.authToken}`);

  // 12. Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    daemon.stop();
    await bridge.stop();
    await spawner.closeAll();
    await feed.stop();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
