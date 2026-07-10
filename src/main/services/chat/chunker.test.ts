import { describe, it, expect } from 'vitest';
import { splitIntoChunks } from './chunker';

describe('splitIntoChunks', () => {
  it('returns a single chunk for short text', () => {
    expect(splitIntoChunks('a short note.', 1000)).toEqual(['a short note.']);
  });

  it('returns nothing for empty/whitespace', () => {
    expect(splitIntoChunks('   \n ')).toEqual([]);
  });

  it('splits on sentence boundaries and stays under size', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} here.`).join(' ');
    const chunks = splitIntoChunks(text, 200, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
  });

  it('carries overlap between consecutive chunks', () => {
    const text = Array.from({ length: 20 }, (_, i) => `word${i} is a sentence.`).join(' ');
    const chunks = splitIntoChunks(text, 120, 40);
    // some tail of chunk 0 reappears at the head of chunk 1
    const tail = chunks[0].slice(-20);
    expect(chunks[1].includes(tail.trim().split(' ').pop()!)).toBe(true);
  });

  it('hard-splits a single oversized sentence so no chunk exceeds size', () => {
    const chunks = splitIntoChunks('x'.repeat(2500) + '.', 1000, 200);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });
});
