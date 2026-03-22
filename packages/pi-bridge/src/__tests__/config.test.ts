/**
 * Tests for model configuration — per-role model selection via env vars.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDefaultModels, getModelForRole } from '../config.js';

describe('Model configuration', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear relevant env vars
    for (const key of ['DIRECTOR_MODEL', 'WORKER_MODEL', 'STEWARD_MODEL']) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  it('should return correct defaults when no env vars are set', () => {
    const models = getDefaultModels();

    expect(models.director).toBe('anthropic/claude-sonnet-4');
    expect(models.worker).toBe('anthropic/claude-sonnet-4');
    expect(models.steward).toBe('anthropic/claude-haiku');
  });

  it('should respect DIRECTOR_MODEL env var', () => {
    process.env.DIRECTOR_MODEL = 'openai/gpt-4o';
    const models = getDefaultModels();
    expect(models.director).toBe('openai/gpt-4o');
  });

  it('should respect WORKER_MODEL env var', () => {
    process.env.WORKER_MODEL = 'anthropic/claude-haiku';
    const models = getDefaultModels();
    expect(models.worker).toBe('anthropic/claude-haiku');
  });

  it('should respect STEWARD_MODEL env var', () => {
    process.env.STEWARD_MODEL = 'meta-llama/llama-3-70b';
    const models = getDefaultModels();
    expect(models.steward).toBe('meta-llama/llama-3-70b');
  });

  it('getModelForRole should return default for role', () => {
    expect(getModelForRole('director')).toBe('anthropic/claude-sonnet-4');
    expect(getModelForRole('steward')).toBe('anthropic/claude-haiku');
  });

  it('getModelForRole should accept config overrides', () => {
    expect(getModelForRole('director', { director: 'custom/model' })).toBe('custom/model');
  });

  it('getModelForRole should fallback to defaults when override is missing', () => {
    expect(getModelForRole('worker', { director: 'custom/model' })).toBe(
      'anthropic/claude-sonnet-4',
    );
  });
});
