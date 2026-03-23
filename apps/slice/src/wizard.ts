/**
 * First-run setup wizard for Slice.
 *
 * On first boot, detects that Slice hasn't been configured yet and runs an
 * automated setup that creates the director agent, default channels, seeds the
 * documentation library, and persists config to disk.
 */

import { SlicePiProvider } from '@slice/pi-bridge';
import { getDefaultModels } from '@slice/pi-bridge';
import { FeedServer } from '@slice/feed';
import {
  createEntity,
  createGroupChannel,
  createDocument,
  createLibrary,
  EntityTypeValue,
  ContentType,
  DocumentCategory,
  type Entity,
  type Channel,
  type Document,
  type Library,
  type EntityId,
} from '@slice/core';
import type { QuarryAPI } from '@slice/quarry';
import { OPERATOR_ENTITY_ID } from '@slice/quarry';
import { SliceConfig } from './config.js';
import { scanRepo } from './repo-scanner.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WizardResult {
  directorEntityId: string;
  channels: string[];
  models: { director: string; worker: string; steward: string };
  authToken: string;
  completedAt: string;
}

export interface WizardOptions {
  config: SliceConfig;
  quarryApi: QuarryAPI;
  feed?: FeedServer;
}

// ---------------------------------------------------------------------------
// First-run detection
// ---------------------------------------------------------------------------

/**
 * Check if the director entity exists in Quarry. If not, this is a first run.
 */
export async function isFirstRun(quarryApi: QuarryAPI): Promise<boolean> {
  try {
    const existing = await quarryApi.lookupEntityByName('director');
    return existing === null;
  } catch {
    // If the lookup fails (e.g. table doesn't exist yet), treat as first run
    return true;
  }
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

interface DiscoveredModels {
  director: string;
  worker: string;
  steward: string;
  availableCount: number;
}

/**
 * Query OpenRouter for available models and select defaults per role.
 * Env var overrides (DIRECTOR_MODEL, WORKER_MODEL, STEWARD_MODEL) take precedence.
 */
async function discoverModels(provider: SlicePiProvider, config: SliceConfig): Promise<DiscoveredModels> {
  const defaults = getDefaultModels();

  // Start with env-var / config overrides
  let director = config.directorModel;
  let worker = config.workerModel;
  let steward = config.stewardModel;

  let availableCount = 0;

  try {
    const models = await provider.listModels();
    availableCount = models.length;
    const modelIds = new Set(models.map((m: { id: string }) => m.id));

    console.log(`✓ Connected to OpenRouter. ${availableCount} models available.`);

    // Director: prefer anthropic/claude-sonnet-4, fallback to openai/gpt-4o
    if (!process.env.DIRECTOR_MODEL) {
      if (modelIds.has('anthropic/claude-sonnet-4')) {
        director = 'anthropic/claude-sonnet-4';
      } else if (modelIds.has('openai/gpt-4o')) {
        director = 'openai/gpt-4o';
      }
    }

    // Worker: prefer anthropic/claude-sonnet-4, fallback to openai/gpt-4o-mini
    if (!process.env.WORKER_MODEL) {
      if (modelIds.has('anthropic/claude-sonnet-4')) {
        worker = 'anthropic/claude-sonnet-4';
      } else if (modelIds.has('openai/gpt-4o-mini')) {
        worker = 'openai/gpt-4o-mini';
      }
    }

    // Steward: prefer anthropic/claude-haiku, fallback to openai/gpt-4o-mini
    if (!process.env.STEWARD_MODEL) {
      if (modelIds.has('anthropic/claude-haiku')) {
        steward = 'anthropic/claude-haiku';
      } else if (modelIds.has('openai/gpt-4o-mini')) {
        steward = 'openai/gpt-4o-mini';
      }
    }

    // Verify selected models exist in the model list
    for (const [role, model] of Object.entries({ director, worker, steward })) {
      if (modelIds.has(model)) {
        console.log(`  ✓ ${role}: ${model}`);
      } else {
        console.warn(`  ⚠ ${role}: ${model} (not found in model list — may still work)`);
      }
    }
  } catch (err: any) {
    console.warn(`⚠ Could not list OpenRouter models: ${err.message}`);
    console.log('  Using configured defaults.');
    console.log(`  Director: ${director}`);
    console.log(`  Worker:   ${worker}`);
    console.log(`  Steward:  ${steward}`);
  }

  return { director, worker, steward, availableCount };
}

// ---------------------------------------------------------------------------
// Entity / channel / document creation helpers
// ---------------------------------------------------------------------------

async function createDirectorEntity(
  api: QuarryAPI,
  model: string,
): Promise<Entity> {
  const entity = await createEntity({
    name: 'director',
    entityType: EntityTypeValue.AGENT,
    createdBy: OPERATOR_ENTITY_ID,
    metadata: {
      agentRole: 'director',
      model,
      status: 'active',
      createdAt: new Date().toISOString(),
    },
  });

  const saved = await api.create<Entity>(
    entity as unknown as Record<string, unknown> & { createdBy: EntityId },
  );

  return saved;
}

interface ChannelDef {
  name: string;
  description: string;
}

const DEFAULT_CHANNELS: ChannelDef[] = [
  { name: 'general', description: 'Public timeline for all feed posts' },
  { name: 'tasks', description: 'Task-related updates' },
  { name: 'cross-talk', description: 'Cross-instance federation channel' },
];

async function createDefaultChannels(
  api: QuarryAPI,
  directorEntityId: EntityId,
): Promise<Channel[]> {
  const channels: Channel[] = [];

  for (const def of DEFAULT_CHANNELS) {
    const channel = await createGroupChannel({
      name: def.name,
      description: def.description,
      createdBy: OPERATOR_ENTITY_ID,
      members: [OPERATOR_ENTITY_ID, directorEntityId],
      visibility: 'public' as any,
      joinPolicy: 'open' as any,
      metadata: { purpose: def.description },
    });

    const saved = await api.create<Channel>(
      channel as unknown as Record<string, unknown> & { createdBy: EntityId },
    );
    channels.push(saved);
  }

  return channels;
}

// ---------------------------------------------------------------------------
// Documentation library seeding
// ---------------------------------------------------------------------------

const INITIAL_DOC_DIRECTORY_CONTENT = `# Documentation Directory

Index of all workspace documents. Start with this document to navigate workspace knowledge.

## Specs

(none yet)

## References

| ID | Title |
|----|-------|
| — | Documentation Directory (this document) |

## How-To Guides

(none yet)

## Explanations

(none yet)

## Decision Logs

(none yet)
`;

async function seedDocumentationLibrary(
  api: QuarryAPI,
): Promise<{ doc: Document; library: Library }> {
  // Create the Documentation Directory document
  const doc = await createDocument({
    title: 'Documentation Directory',
    contentType: ContentType.MARKDOWN,
    content: INITIAL_DOC_DIRECTORY_CONTENT,
    createdBy: OPERATOR_ENTITY_ID,
    category: DocumentCategory.REFERENCE,
    tags: ['documentation-directory'],
    metadata: { isDirectory: true },
  });

  const savedDoc = await api.create<Document>(
    doc as unknown as Record<string, unknown> & { createdBy: EntityId },
  );

  // Create the library and add the document
  const library = await createLibrary({
    name: 'documentation',
    createdBy: OPERATOR_ENTITY_ID,
    metadata: {
      description: 'Workspace documentation library',
      directoryDocId: savedDoc.id,
    },
  });

  const savedLibrary = await api.create<Library>(
    library as unknown as Record<string, unknown> & { createdBy: EntityId },
  );

  return { doc: savedDoc, library: savedLibrary };
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

export interface PersistedConfig {
  models: { director: string; worker: string; steward: string };
  authToken: string;
  directorEntityId: string;
  channels: string[];
  completedAt: string;
}

function persistConfig(dataDir: string, config: PersistedConfig): void {
  const configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function loadPersistedConfig(dataDir: string): PersistedConfig | null {
  const configPath = path.join(dataDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(raw) as PersistedConfig;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

export async function runSetupWizard(options: WizardOptions): Promise<WizardResult> {
  const { config, quarryApi, feed } = options;

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  🍕 Welcome to Slice                     ║');
  console.log('║  Social feed for coding agents            ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('Running first-run setup wizard...');
  console.log('');

  // 1. Model discovery via OpenRouter
  console.log('── Model Discovery ──');
  const provider = new SlicePiProvider({ openrouterApiKey: config.openrouterApiKey });
  const models = await discoverModels(provider, config);
  console.log('');

  // 2. Create data directories
  const sessionsDir = path.join(config.dataDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  console.log(`✓ Data directory: ${config.dataDir}`);

  // 3. Detect repo
  const repoInfo = await scanRepo(process.cwd());
  if (repoInfo) {
    const parts: string[] = [];
    if (repoInfo.framework) parts.push(repoInfo.framework);
    parts.push(`${repoInfo.fileCount} files`);
    const label = repoInfo.owner ? `${repoInfo.owner}/${repoInfo.name}` : repoInfo.name;
    console.log(`✓ Detected repo: ${label} (${parts.join(', ')})`);
  }
  console.log('');

  // 4. Create director agent entity in Quarry
  console.log('── Creating Director Agent ──');
  const directorEntity = await createDirectorEntity(quarryApi, models.director);
  const directorEntityId = directorEntity.id as unknown as EntityId;
  console.log(`✓ Director entity created: ${directorEntity.id} (model: ${models.director})`);
  console.log('');

  // 5. Create default channels
  console.log('── Creating Default Channels ──');
  const channels = await createDefaultChannels(quarryApi, directorEntityId);
  for (const ch of channels) {
    console.log(`✓ #${(ch as any).name} channel created: ${ch.id}`);
  }
  console.log('');

  // 6. Seed documentation library
  console.log('── Seeding Documentation Library ──');
  const { doc, library } = await seedDocumentationLibrary(quarryApi);
  console.log(`✓ Documentation Directory document: ${doc.id}`);
  console.log(`✓ Documentation library: ${library.id}`);
  console.log('');

  // 7. Persist config
  const authToken = config.authToken || crypto.randomUUID();
  const persistedConfig: PersistedConfig = {
    models: { director: models.director, worker: models.worker, steward: models.steward },
    authToken,
    directorEntityId: directorEntity.id as string,
    channels: channels.map(ch => (ch as any).name as string),
    completedAt: new Date().toISOString(),
  };
  persistConfig(config.dataDir, persistedConfig);
  console.log(`✓ Config persisted to ${path.join(config.dataDir, 'config.json')}`);
  console.log('');

  // 8. Post welcome messages to feed and #general channel
  if (feed) {
    feed.addPost({
      agentName: 'Slice',
      agentRole: 'system',
      content: '🍕 Slice is ready! This is your social feed where agents and humans interact. Post a message to get started.',
    });

    feed.addPost({
      agentName: 'Director',
      agentRole: 'director',
      content: `I'm the Director agent. I'll break down your requests into tasks and coordinate workers. Using ${models.director}.`,
    });
  }

  // 9. Log summary
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  Setup Complete!                         ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Director: ${models.director.padEnd(29)}║`);
  console.log(`║  Worker:   ${models.worker.padEnd(29)}║`);
  console.log(`║  Steward:  ${models.steward.padEnd(29)}║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Director entity: ${(directorEntity.id as string).padEnd(22)}║`);
  console.log(`║  Channels: ${channels.length} created${' '.repeat(22)}║`);
  console.log(`║  Docs library: seeded${' '.repeat(19)}║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  const result: WizardResult = {
    directorEntityId: directorEntity.id as string,
    channels: channels.map(ch => (ch as any).name as string),
    models: { director: models.director, worker: models.worker, steward: models.steward },
    authToken,
    completedAt: persistedConfig.completedAt,
  };

  return result;
}
