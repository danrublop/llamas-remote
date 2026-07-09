// Round-trip tests for the on-disk entry format. The Markdown files are the notebook's
// source of truth, so serialize→parse must be lossless for the fields and bodies we write.
// (The SQLite index is rebuilt from these files on launch, so a parse bug = data loss.)

import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, existsSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { serializeEntry, parseEntry, isValidEntryId, makeEntry, MarkdownStore } from './markdown-store';
import type { NotebookEntry } from './types';

const base: NotebookEntry = {
  id: '01J-test-id',
  title: 'Explain — const x = 1',
  body: 'This is the answer body.',
  tags: ['Safari', 'typescript'],
  model: 'llama3.2',
  sourceApp: 'Safari',
  sourceKind: 'text',
  pinned: false,
  createdAt: '2026-05-25T17:00:00.000Z',
};

const roundTrip = (e: NotebookEntry) => parseEntry(serializeEntry(e));

describe('serializeEntry ↔ parseEntry round-trip', () => {
  it('preserves every field on a basic entry', () => {
    expect(roundTrip(base)).toEqual(base);
  });

  it('preserves a pinned entry with an image path', () => {
    const e = { ...base, pinned: true, sourceKind: 'image' as const, imagePath: '/notebook/images/01J.png' };
    expect(roundTrip(e)).toEqual(e);
  });

  it('round-trips values containing : and # (which trigger quoting)', () => {
    const e = { ...base, title: 'Ratio 3:1 # of cases', sourceApp: 'App: Beta #2' };
    const out = roundTrip(e);
    expect(out?.title).toBe('Ratio 3:1 # of cases');
    expect(out?.sourceApp).toBe('App: Beta #2');
  });

  it('preserves a body that contains a --- horizontal rule', () => {
    const e = { ...base, body: 'Step 1\n\n---\n\nStep 2' };
    expect(roundTrip(e)?.body).toBe('Step 1\n\n---\n\nStep 2');
  });

  it('preserves a body that opens with frontmatter-looking text', () => {
    const e = { ...base, body: '---\nnot: real\n---\nactual answer' };
    expect(roundTrip(e)?.body).toBe('---\nnot: real\n---\nactual answer');
  });

  it('preserves unicode and multi-line bodies', () => {
    const e = { ...base, body: 'café ☕\nlínea dos\n\tindented', tags: ['Café', 'ünïcode'] };
    const out = roundTrip(e);
    expect(out?.body).toBe('café ☕\nlínea dos\n\tindented');
    expect(out?.tags).toEqual(['Café', 'ünïcode']);
  });

  it('handles an empty tag list', () => {
    expect(roundTrip({ ...base, tags: [] })?.tags).toEqual([]);
  });

  it('handles an empty body', () => {
    expect(roundTrip({ ...base, body: '' })?.body).toBe('');
  });
});

describe('MarkdownStore.write (atomic)', () => {
  let dir: string;
  afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

  it('persists the entry and leaves no temp file behind', () => {
    dir = mkdtempSync(join(tmpdir(), 'lr-md-'));
    const store = new MarkdownStore(dir);
    const entry = makeEntry({ id: 'note1', body: 'hello', tags: [], model: 'llama3.2', sourceApp: 'Safari' });
    store.write(entry);
    // only the final .md exists — the temp+rename left no note1.md.tmp
    expect(readdirSync(dir)).toEqual(['note1.md']);
    expect(store.read('note1')?.body).toBe('hello');
  });

  it('overwrites atomically on a second write', () => {
    dir = mkdtempSync(join(tmpdir(), 'lr-md-'));
    const store = new MarkdownStore(dir);
    store.write(makeEntry({ id: 'note1', body: 'first', tags: [], model: 'm', sourceApp: 'a' }));
    store.write(makeEntry({ id: 'note1', body: 'second', tags: [], model: 'm', sourceApp: 'a' }));
    expect(readdirSync(dir)).toEqual(['note1.md']);
    expect(store.read('note1')?.body).toBe('second');
  });
});

describe('isValidEntryId (path-traversal guard)', () => {
  it('accepts server-generated ids (UUIDs and our safe alphabet)', () => {
    expect(isValidEntryId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidEntryId('01J-test-id')).toBe(true);
    expect(isValidEntryId('abc_123')).toBe(true);
  });

  it('rejects traversal, separators, and absolute paths that would escape the notebook dir', () => {
    expect(isValidEntryId('../../etc/passwd')).toBe(false);
    expect(isValidEntryId('..')).toBe(false);
    expect(isValidEntryId('/Users/me/Documents/secret')).toBe(false);
    expect(isValidEntryId('a/b')).toBe(false);
    expect(isValidEntryId('id.with.dots')).toBe(false); // '.' not allowed -> no `..` ever
    expect(isValidEntryId('id with spaces')).toBe(false);
    expect(isValidEntryId('')).toBe(false);
    expect(isValidEntryId('x'.repeat(129))).toBe(false); // length-capped
  });

  it('rejects non-strings', () => {
    expect(isValidEntryId(undefined)).toBe(false);
    expect(isValidEntryId(null)).toBe(false);
    expect(isValidEntryId(42)).toBe(false);
  });
});

describe('parseEntry rejects malformed input', () => {
  it('returns null without a frontmatter block', () => {
    expect(parseEntry('just a body, no frontmatter')).toBeNull();
  });

  it('returns null when the frontmatter is unterminated', () => {
    expect(parseEntry('---\nid: x\ntitle: y\nstill open')).toBeNull();
  });

  it('returns null when id is missing (file would be unaddressable)', () => {
    expect(parseEntry('---\ntitle: y\n---\nbody')).toBeNull();
  });
});
