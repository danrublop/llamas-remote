import { describe, it, expect } from 'vitest';
import { routeModel, isVisionCapable, type RouterConfig } from './model-router';
import { CLOUD_MODELS } from '../llm/multi-llm-client';
import type { Preset } from '../presets/presets';

const config: RouterConfig = { defaultTextModel: 'llama3.2', visionModel: 'llava' };

const preset = (over: Partial<Preset> = {}): Preset => ({
  id: 'explain',
  name: 'Explain',
  promptTemplate: '{selection}',
  accepts: 'both',
  ...over,
});

describe('routeModel', () => {
  it('routes image input to the local vision model when no vision-capable model is picked', () => {
    expect(routeModel({ kind: 'image' }, config).model).toBe('llava');
    // A text-default preset doesn't make a non-vision model handle an image.
    expect(routeModel({ kind: 'image', preset: preset({ defaultModel: 'mistral' }) }, config).model).toBe('llava');
    // A user-picked text-only model can't see -> still falls back to local vision.
    expect(routeModel({ kind: 'image', userSelectedModel: 'mistral:latest' }, config).model).toBe('llava');
  });

  it('honors a user-picked vision-capable model for image input (cloud or local)', () => {
    expect(routeModel({ kind: 'image', userSelectedModel: 'openai/gpt-4o' }, config).model).toBe('openai/gpt-4o');
    expect(routeModel({ kind: 'image', userSelectedModel: 'anthropic/claude-sonnet-4-5' }, config).model)
      .toBe('anthropic/claude-sonnet-4-5');
    expect(routeModel({ kind: 'image', userSelectedModel: 'llava:13b' }, config).model).toBe('llava:13b');
  });

  it('lets the user-selected model win over a preset default for text', () => {
    const r = routeModel({ kind: 'text', preset: preset({ defaultModel: 'qwen2.5-coder' }), userSelectedModel: 'mistral' }, config);
    expect(r.model).toBe('mistral');
  });

  it('uses the preset default model when the user picked nothing', () => {
    const r = routeModel({ kind: 'text', preset: preset({ defaultModel: 'qwen2.5-coder' }) }, config);
    expect(r.model).toBe('qwen2.5-coder');
  });

  it('falls back to the global default text model when nothing else applies', () => {
    expect(routeModel({ kind: 'text' }, config).model).toBe('llama3.2');
  });

  it('always returns a reason', () => {
    expect(routeModel({ kind: 'text' }, config).reason).toBeTruthy();
    expect(routeModel({ kind: 'image' }, config).reason).toBeTruthy();
  });
});

describe('isVisionCapable', () => {
  it('recognizes cloud vision models', () => {
    expect(isVisionCapable('openai/gpt-4o')).toBe(true);
    expect(isVisionCapable('openai/gpt-4o-mini')).toBe(true);
    expect(isVisionCapable('anthropic/claude-sonnet-4-5')).toBe(true);
    // Haiku 4.5 accepts image input (standard-resolution vision tier).
    expect(isVisionCapable('anthropic/claude-haiku-4-5')).toBe(true);
  });

  it('does not treat the retired text-only claude-3-5-haiku as vision-capable', () => {
    // Regression: it was wrongly listed vision-capable and 404s besides. "haiku" in the id
    // must not match a local vision hint either.
    expect(isVisionCapable('anthropic/claude-3-5-haiku-latest')).toBe(false);
  });

  it('recognizes local vision tags by substring', () => {
    expect(isVisionCapable('llava:latest')).toBe(true);
    expect(isVisionCapable('llama3.2-vision:11b')).toBe(true);
    expect(isVisionCapable('moondream')).toBe(true);
  });

  it('treats unknown / text-only models as not vision-capable', () => {
    expect(isVisionCapable('mistral:latest')).toBe(false);
    expect(isVisionCapable('qwen2.5-coder')).toBe(false);
    expect(isVisionCapable(undefined)).toBe(false);
  });

  // Drift guard: the cloud-vision allow-list in model-router duplicates the cloud model
  // catalog in multi-llm-client. Every offered cloud model today is vision-capable; adding
  // a new cloud model without classifying it here fails this test.
  it('classifies every offered cloud model (catches CLOUD_MODELS/CLOUD_VISION drift)', () => {
    for (const id of [...CLOUD_MODELS.openai, ...CLOUD_MODELS.anthropic]) {
      expect(isVisionCapable(id)).toBe(true);
    }
  });
});
