import { describe, it, expect } from 'vitest';
import { parseModel, CLOUD_MODELS } from './multi-llm-client';

describe('parseModel', () => {
  it('routes prefixed ids to their provider', () => {
    expect(parseModel('openai/gpt-4o')).toEqual({ provider: 'openai', id: 'gpt-4o' });
    expect(parseModel('anthropic/claude-haiku-4-5')).toEqual({ provider: 'anthropic', id: 'claude-haiku-4-5' });
    expect(parseModel('mistral:latest')).toEqual({ provider: 'ollama', id: 'mistral:latest' });
  });
});

describe('CLOUD_MODELS', () => {
  it('offers the current Anthropic models and not the retired 3.5 haiku', () => {
    expect(CLOUD_MODELS.anthropic).toContain('anthropic/claude-haiku-4-5');
    // claude-3-5-haiku was retired 2026-02-19 and 404s.
    expect(CLOUD_MODELS.anthropic).not.toContain('anthropic/claude-3-5-haiku-latest');
  });
});
