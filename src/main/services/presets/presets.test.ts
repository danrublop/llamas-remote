import { describe, it, expect } from 'vitest';
import { renderPrompt, canHandle, BUILT_IN_PRESETS, type Preset } from './presets';

describe('renderPrompt', () => {
  it('interpolates {selection}', () => {
    expect(renderPrompt('Explain:\n\n{selection}', { selection: 'const x = 1' })).toBe(
      'Explain:\n\nconst x = 1',
    );
  });

  it('interpolates {image}', () => {
    expect(renderPrompt('Look at {image} please', { image: '<screenshot>' })).toBe(
      'Look at <screenshot> please',
    );
  });

  it('renders missing vars as empty and trims trailing whitespace', () => {
    expect(renderPrompt('Q:\n\n{selection}', {})).toBe('Q:');
  });

  it('replaces all occurrences', () => {
    expect(renderPrompt('{selection} and {selection}', { selection: 'x' })).toBe('x and x');
  });

  it('leaves unknown tokens untouched so typos are visible', () => {
    expect(renderPrompt('hi {seletcion}', { selection: 'x' })).toBe('hi {seletcion}');
  });

  it('preserves trailing-double-space hard line-breaks inside the selection', () => {
    const selection = 'line one  \nline two  \nline three';
    expect(renderPrompt('Explain:\n\n{selection}', { selection })).toBe(
      `Explain:\n\n${selection}`,
    );
  });
});

describe('canHandle', () => {
  const p = (accepts: Preset['accepts']): Preset => ({
    id: 't',
    name: 'T',
    promptTemplate: '{selection}',
    accepts,
  });

  it('matches the declared kind', () => {
    expect(canHandle(p('text'), 'text')).toBe(true);
    expect(canHandle(p('text'), 'image')).toBe(false);
    expect(canHandle(p('image'), 'image')).toBe(true);
    expect(canHandle(p('both'), 'text')).toBe(true);
    expect(canHandle(p('both'), 'image')).toBe(true);
  });
});

describe('BUILT_IN_PRESETS', () => {
  it('has unique ids and non-empty templates', () => {
    const ids = BUILT_IN_PRESETS.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of BUILT_IN_PRESETS) {
      expect(preset.promptTemplate.length).toBeGreaterThan(0);
      expect(preset.name.length).toBeGreaterThan(0);
    }
  });

  it('ships the five expected actions', () => {
    expect(BUILT_IN_PRESETS.map((x) => x.id)).toEqual([
      'explain',
      'summarize',
      'rewrite',
      'translate',
      'find-bugs',
    ]);
  });
});
