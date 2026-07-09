import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseAnchorIds, reconcileSidecar, readSidecar, writeSidecar, sanitizeIncomingBlocks, type AIBlockMeta } from './sidecar';

const meta = (blockId: string): AIBlockMeta => ({ blockId, prompt: `p-${blockId}`, model: 'llama3.2', createdAt: '2026-05-26T00:00:00Z' });

describe('parseAnchorIds', () => {
  it('extracts anchor ids in document order', () => {
    const md = 'intro\n\n<!--ai:01ABC-->\nanswer one\n\n<!--ai:02XYZ-->\nanswer two';
    expect(parseAnchorIds(md)).toEqual(['01ABC', '02XYZ']);
  });

  it('tolerates whitespace inside the comment', () => {
    expect(parseAnchorIds('<!--  ai:zzz  -->')).toEqual(['zzz']);
  });

  it('ignores malformed or non-ai comments', () => {
    expect(parseAnchorIds('<!-- not an anchor --> <!--ai:-->')).toEqual([]);
  });

  it('returns empty for prose with no anchors', () => {
    expect(parseAnchorIds('just text')).toEqual([]);
  });
});

describe('reconcileSidecar', () => {
  it('keeps meta whose anchor survives, in document order', () => {
    const r = reconcileSidecar(['b', 'a'], [meta('a'), meta('b')]);
    expect(r.live.map((m) => m.blockId)).toEqual(['b', 'a']); // anchor order, not meta order
    expect(r.orphaned).toEqual([]);
  });

  it('orphans meta whose anchor was removed from the prose', () => {
    const r = reconcileSidecar(['a'], [meta('a'), meta('gone')]);
    expect(r.live.map((m) => m.blockId)).toEqual(['a']);
    expect(r.orphaned).toEqual(['gone']);
  });

  it('an anchor with no meta yields no entry (renders as plain block)', () => {
    const r = reconcileSidecar(['a', 'noMeta'], [meta('a')]);
    expect(r.live.map((m) => m.blockId)).toEqual(['a']);
    expect(r.orphaned).toEqual([]);
  });

  it('handles empty inputs', () => {
    expect(reconcileSidecar([], [])).toEqual({ live: [], orphaned: [] });
  });
});

describe('readSidecar / writeSidecar', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nb-sc-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('round-trips blocks', () => {
    writeSidecar(dir, 'note1', [meta('a'), meta('b')]);
    const read = readSidecar(dir, 'note1');
    expect(read?.blocks.map((b) => b.blockId)).toEqual(['a', 'b']);
    expect(read?.version).toBe(1);
  });

  it('returns null for a missing sidecar', () => {
    expect(readSidecar(dir, 'nope')).toBeNull();
  });

  it('returns null for malformed JSON (treated as no metadata)', () => {
    writeFileSync(join(dir, 'bad.meta.json'), '{not json', 'utf8');
    expect(readSidecar(dir, 'bad')).toBeNull();
  });

  it('deletes the sidecar when written with no blocks', () => {
    writeSidecar(dir, 'note2', [meta('a')]);
    expect(existsSync(join(dir, 'note2.meta.json'))).toBe(true);
    writeSidecar(dir, 'note2', []);
    expect(existsSync(join(dir, 'note2.meta.json'))).toBe(false);
  });

  it('drops entries without a string blockId on read', () => {
    writeFileSync(join(dir, 'mix.meta.json'), JSON.stringify({ version: 1, blocks: [{ blockId: 'ok', prompt: 'p', model: 'm', createdAt: 't' }, { prompt: 'no id' }] }), 'utf8');
    expect(readSidecar(dir, 'mix')?.blocks.map((b) => b.blockId)).toEqual(['ok']);
  });
});

describe('sanitizeIncomingBlocks (untrusted renderer input)', () => {
  it('keeps valid blocks and their re-run inputs', () => {
    expect(sanitizeIncomingBlocks([{ blockId: 'b1', prompt: 'p', model: 'm', commandId: 'c', selection: 's' }]))
      .toEqual([{ blockId: 'b1', prompt: 'p', model: 'm', commandId: 'c', selection: 's' }]);
  });

  it('drops entries with a missing or unsafe blockId', () => {
    const out = sanitizeIncomingBlocks([{ blockId: '../etc' }, { prompt: 'no id' }, { blockId: 'has space' }, { blockId: 'ok', prompt: 'p', model: 'm' }]);
    expect(out.map((b) => b.blockId)).toEqual(['ok']);
  });

  it('dedups repeated blockIds (copy/paste of a block), keeping the first', () => {
    const out = sanitizeIncomingBlocks([{ blockId: 'b', prompt: 'first', model: 'm' }, { blockId: 'b', prompt: 'second', model: 'm' }]);
    expect(out).toHaveLength(1);
    expect(out[0].prompt).toBe('first');
  });

  it('defaults missing strings and ignores non-string optionals', () => {
    expect(sanitizeIncomingBlocks([{ blockId: 'b', prompt: 5, commandId: {} }]))
      .toEqual([{ blockId: 'b', prompt: '', model: '', commandId: undefined, selection: undefined }]);
  });

  it('caps an oversized field so a runaway selection cannot bloat the sidecar', () => {
    const out = sanitizeIncomingBlocks([{ blockId: 'b', selection: 'x'.repeat(200_000) }]);
    expect(out[0].selection?.length).toBe(100_000);
  });

  it('returns [] for non-array input', () => {
    expect(sanitizeIncomingBlocks(null)).toEqual([]);
    expect(sanitizeIncomingBlocks('nope')).toEqual([]);
    expect(sanitizeIncomingBlocks(undefined)).toEqual([]);
  });
});
