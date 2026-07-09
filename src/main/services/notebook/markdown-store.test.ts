// Round-trip tests for the on-disk entry format. The Markdown files are the notebook's
// source of truth, so serialize→parse must be lossless for the fields and bodies we write.
// (The SQLite index is rebuilt from these files on launch, so a parse bug = data loss.)

import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, existsSync, rmSync, mkdtempSync, writeFileSync, utimesSync } from 'fs';
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

  // Tags are user-editable: a comma, bracket, quote, or surrounding whitespace must not
  // corrupt the flow list (the reader splits on ',' and strips '[' / ']'). These force the
  // strict-JSON serialization path.
  it('round-trips tags containing commas, brackets and quotes intact', () => {
    const e = { ...base, tags: ['a,b', 'c]d', 'e[f', 'quote"y', 'plain'] };
    expect(roundTrip(e)?.tags).toEqual(['a,b', 'c]d', 'e[f', 'quote"y', 'plain']);
  });

  it('preserves a tag with internal whitespace', () => {
    const e = { ...base, tags: ['two words', 'plain'] };
    expect(roundTrip(e)?.tags).toEqual(['two words', 'plain']);
  });

  // Files written before the esc fix use a bare comma-joined list; that form must still parse.
  it('still reads legacy bare comma-list tags', () => {
    const legacy = '---\nid: legacy1\ntitle: t\ntags: [code, safari]\n---\nbody';
    expect(parseEntry(legacy)?.tags).toEqual(['code', 'safari']);
  });

  // Regression (MF-1): a tag that looks like a bare JSON literal (year/number/bool/null)
  // must survive. Written bare as `[2024]` it would JSON-decode to a number and get dropped,
  // so the serializer forces the quoted JSON form for these.
  it('round-trips numeric / boolean / null-literal tags', () => {
    const e = { ...base, tags: ['2024', '42', 'true', 'false', 'null'] };
    expect(roundTrip(e)?.tags).toEqual(['2024', '42', 'true', 'false', 'null']);
  });

  it('round-trips an all-numeric single-tag set (the exact MF-1 repro)', () => {
    expect(roundTrip({ ...base, tags: ['2024'] })?.tags).toEqual(['2024']);
  });

  it('round-trips numeric tags mixed with word tags', () => {
    const e = { ...base, tags: ['work', '2024', 'q3'] };
    expect(roundTrip(e)?.tags).toEqual(['work', '2024', 'q3']);
  });

  // Recovery: a file the OLD serializer already wrote as a bare numeric list `[2024]`
  // must decode back to the string tag "2024", not vanish.
  it('recovers a pre-fix bare numeric tag list from disk', () => {
    const legacy = '---\nid: legacy2\ntitle: t\ntags: [2024]\n---\nbody';
    expect(parseEntry(legacy)?.tags).toEqual(['2024']);
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

describe('MarkdownStore.listDiskEntries (stat-first scan)', () => {
  let dir: string;
  afterEach(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

  const writeRaw = (d: string, id: string, body: string): string => {
    const path = join(d, `${id}.md`);
    writeFileSync(path, serializeEntry(makeEntry({ id, body, tags: [], model: 'm', sourceApp: 'a' })), 'utf8');
    return path;
  };

  it('returns every entry on disk', () => {
    dir = mkdtempSync(join(tmpdir(), 'lr-md-'));
    writeRaw(dir, 'a', 'alpha');
    writeRaw(dir, 'b', 'beta');
    const store = new MarkdownStore(dir);
    const ids = store.listDiskEntries().map((e) => e.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  // Correctness of the stat-first optimization: a file whose mtime is UNCHANGED is not
  // re-read. We prove it by mutating the file bytes while pinning mtime back to its old
  // value — the scan must return the cached (stale) body, showing it skipped the read.
  it('skips re-reading a file whose mtime is unchanged since the last scan', () => {
    dir = mkdtempSync(join(tmpdir(), 'lr-md-'));
    const path = writeRaw(dir, 'a', 'original');
    // Pin an exact, integer-second mtime so restoring it later reproduces the same mtimeMs
    // (avoids sub-ms fs precision differences between the two writes).
    const fixed = new Date(Math.floor(Date.now() / 1000) * 1000);
    utimesSync(path, fixed, fixed);
    const store = new MarkdownStore(dir);

    const first = store.listDiskEntries();
    expect(first.find((e) => e.id === 'a')?.body).toBe('original');

    // Rewrite the body but restore the identical mtime → the scan must treat it as unchanged.
    writeFileSync(path, serializeEntry(makeEntry({ id: 'a', body: 'CHANGED', tags: [], model: 'm', sourceApp: 'a' })), 'utf8');
    utimesSync(path, fixed, fixed);

    const second = store.listDiskEntries();
    expect(second.find((e) => e.id === 'a')?.body).toBe('original'); // cached, not re-read
  });

  it('re-reads a file whose mtime advanced (picks up external edits)', () => {
    dir = mkdtempSync(join(tmpdir(), 'lr-md-'));
    const path = writeRaw(dir, 'a', 'original');
    const store = new MarkdownStore(dir);
    store.listDiskEntries();

    writeFileSync(path, serializeEntry(makeEntry({ id: 'a', body: 'edited externally', tags: [], model: 'm', sourceApp: 'a' })), 'utf8');
    const future = new Date(Date.now() + 60_000);
    utimesSync(path, future, future);

    const out = store.listDiskEntries();
    expect(out.find((e) => e.id === 'a')?.body).toBe('edited externally');
    expect(out.find((e) => e.id === 'a')?.mtimeMs).toBeGreaterThan(0);
  });

  it('drops deleted files from the scan (cache does not leak them)', () => {
    dir = mkdtempSync(join(tmpdir(), 'lr-md-'));
    writeRaw(dir, 'a', 'alpha');
    writeRaw(dir, 'b', 'beta');
    const store = new MarkdownStore(dir);
    expect(store.listDiskEntries().map((e) => e.id).sort()).toEqual(['a', 'b']);

    rmSync(join(dir, 'a.md'));
    expect(store.listDiskEntries().map((e) => e.id)).toEqual(['b']);
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
