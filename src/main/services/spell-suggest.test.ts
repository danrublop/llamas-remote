import { describe, it, expect } from 'vitest';
import { editDistance, spellSuggest } from './spell-suggest';

describe('editDistance', () => {
  it('measures small edits and bails past max', () => {
    expect(editDistance('kitten', 'sitting', 3)).toBe(3);
    expect(editDistance('speling', 'spelling', 2)).toBe(1);
    expect(editDistance('cat', 'dog', 2)).toBe(3); // over max → max + 1
  });
});

describe('spellSuggest', () => {
  const dict = ['spelling', 'spline', 'speaking', 'basically', 'basic', 'suggestion'];

  it('finds near-matches within edit distance 2, closest first', () => {
    expect(spellSuggest('speling', dict)[0]).toBe('spelling'); // distance 1 wins
    expect(spellSuggest('basicly', dict)).toEqual(expect.arrayContaining(['basic', 'basically']));
  });

  it('preserves leading capitalization of the misspelling', () => {
    expect(spellSuggest('Speling', dict)).toContain('Spelling');
  });

  it('returns nothing for a 1-char word or when no candidate is close', () => {
    expect(spellSuggest('x', dict)).toEqual([]);
    expect(spellSuggest('zzzzz', dict)).toEqual([]);
  });
});
