import { SlicePiProvider } from '@slice/pi-bridge';
import { FeedServer } from '@slice/feed';
import { SliceConfig } from './config.js';
import { scanRepo } from './repo-scanner.js';
import * as fs from 'fs';
import * as path from 'path';

export interface WizardResult {
  directorEntityId: string;
  channels: string[];
  models: { director: string; worker: string; steward: string };
  completedAt: string;
}

export async function runSetupWizard(config: SliceConfig, feed?: FeedServer): Promise<WizardResult> {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║     Welcome to Slice                 ║');
  console.log('║     Social feed for coding agents              ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  // 1. Test OpenRouter connection
  const provider = new SlicePiProvider({ openrouterApiKey: config.openrouterApiKey });
  console.log('Testing OpenRouter connection...');

  let modelCount = 0;
  try {
    const models = await provider.listModels();
    modelCount = models.length;
    console.log(`✓ Connected to OpenRouter. ${modelCount} models available.`);

    // Verify selected models exist
    const modelIds = new Set(models.map(m => m.id));
    for (const [role, model] of Object.entries({ director: config.directorModel, worker: config.workerModel, steward: config.stewardModel })) {
      if (modelIds.has(model)) {
        console.log(`✓ ${role}: ${model}`);
      } else {
        console.warn(`⚠ ${role}: ${model} (not found in model list — may still work)`);
      }
    }
  } catch (err: any) {
    console.error('✗ Failed to connect to OpenRouter:', err.message);
    throw err;
  }

  // 2. Create data directories
  const sessionsDir = path.join(config.dataDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  console.log(`✓ Data directory: ${config.dataDir}`);

  // 2b. Detect repo
  const repoInfo = await scanRepo(process.cwd());
  if (repoInfo) {
    const parts: string[] = [];
    if (repoInfo.framework) parts.push(repoInfo.framework);
    parts.push(`${repoInfo.fileCount} files`);
    const label = repoInfo.owner ? `${repoInfo.owner}/${repoInfo.name}` : repoInfo.name;
    console.log(`✓ Detected repo: ${label} (${parts.join(', ')})`);
  }

  // 3. Post welcome messages to feed if available
  if (feed) {
    feed.addPost({
      agentName: 'Slice',
      agentRole: 'system',
      content: '🔷 Slice is set up and ready! This is your social feed where agents and humans interact. Post a message to get started.',
    });

    feed.addPost({
      agentName: 'Director',
      agentRole: 'director',
      content: `I'm the Director agent. I'll break down your requests into tasks and coordinate workers. Using ${config.directorModel}.`,
    });
  }

  const result: WizardResult = {
    directorEntityId: 'director-' + Date.now(),
    channels: ['general', 'tasks', 'cross-talk'],
    models: {
      director: config.directorModel,
      worker: config.workerModel,
      steward: config.stewardModel,
    },
    completedAt: new Date().toISOString(),
  };

  console.log('');
  console.log('Setup complete! Open the feed in your browser.');
  console.log('');

  return result;
}
