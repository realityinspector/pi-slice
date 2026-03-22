/**
 * Model configuration — maps agent roles to OpenRouter model IDs.
 */

export interface ModelConfig {
  director: string;
  worker: string;
  steward: string;
}

export function getDefaultModels(): ModelConfig {
  return {
    director: process.env.DIRECTOR_MODEL || 'anthropic/claude-sonnet-4',
    worker: process.env.WORKER_MODEL || 'anthropic/claude-sonnet-4',
    steward: process.env.STEWARD_MODEL || 'anthropic/claude-haiku',
  };
}

export function getModelForRole(
  role: keyof ModelConfig,
  config?: Partial<ModelConfig>,
): string {
  const defaults = getDefaultModels();
  return config?.[role] ?? defaults[role];
}
