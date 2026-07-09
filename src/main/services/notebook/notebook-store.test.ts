import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MarkdownStore, makeEntry, serializeEntry } from './markdown-store';
import { NotebookStore } from './notebook-store';
import type { IndexRow } from './reconcile';
import type { IndexUpsert, NotebookIndex, NoteSummary, SearchHit } from './types';

// In-memory NotebookIndex fake — stands in for the SQLite FTS5 index so the store logic
// is tested headless (no native module). Search is a naive case-insensitive substring.
class FakeIndex implements NotebookIndex {
  rows = new Map<string, { title?: string; body: string; tags: string[]; pinned: boolean; mtime: number; tombstoned: boolean }>();

  allRows(): IndexRow[] {
    return [...this.rows.entries()].map(([id, r]) => ({
      id,
      tags: r.tags,
      indexedMtimeMs: r.mtime,
      tombstoned: r.tombstoned,
    }));
  }
  upsert(row: IndexUpsert): void {
    const prev = this.rows.get(row.id);
    this.rows.set(row.id, { title: row.title ?? prev?.title, body: row.body, tags: row.tags, pinned: row.pinned ?? prev?.pinned ?? false, mtime: row.indexedMtimeMs, tombstoned: prev?.tombstoned ?? false });
  }
  tombstone(id: string): void {
    const r = this.rows.get(id);
    if (r) r.tombstoned = true;
  }
  untombstone(id: string): void {
    const r = this.rows.get(id);
    if (r) r.tombstoned = false;
  }
  search(query: string): SearchHit[] {
    const q = query.toLowerCase();
    return [...this.rows.entries()]
      .filter(([, r]) => !r.tombstoned && r.body.toLowerCase().includes(q))
      .map(([id, r]) => ({ id, snippet: r.body.slice(0, 40), tags: r.tags }));
  }
  list(): NoteSummary[] {
    return [...this.rows.entries()].filter(([, r]) => !r.tombstoned).map(([id, r]) => ({ id, title: r.title ?? r.body.slice(0, 40), snippet: r.body.slice(0, 80), tags: r.tags, pinned: r.pinned, createdAt: '' }));
  }
  getAllTags(): string[] {
    const seen = new Map<string, string>();
    for (const [, r] of this.rows) {
      if (r.tombstoned) continue;
      for (const t of r.tags) { const k = t.trim().toLowerCase(); if (k && !seen.has(k)) seen.set(k, t.trim()); }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }
  getBody(id: string): string | null { const r = this.rows.get(id); return r && !r.tombstoned ? r.body : null; }
  getImagePath(): string | null { return null; }
  setTitle(id: string, title: string): void { const r = this.rows.get(id); if (r) r.title = title; }
  setPinned(id: string, pinned: boolean): void { const r = this.rows.get(id); if (r) r.pinned = pinned; }
  setTags(id: string, tags: string[]): void { const r = this.rows.get(id); if (r) r.tags = tags; }
  updateBody(id: string, body: string): void { const r = this.rows.get(id); if (r) r.body = body; }
}

let dir: string;
let files: MarkdownStore;
let index: FakeIndex;
let store: NotebookStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'notebook-test-'));
  files = new MarkdownStore(dir);
  index = new FakeIndex();
  store = new NotebookStore(files, index);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Force a file's mtime forward so reconcile sees it as newer than the index. */
function bumpMtime(path: string, msAhead = 5000): number {
  const future = new Date(Date.now() + msAhead);
  utimesSync(path, future, future);
  return statSync(path).mtimeMs;
}

describe('NotebookStore', () => {
  it('save() writes a markdown file and indexes it; search finds it', () => {
    store.save(makeEntry({ id: 'e1', body: 'The regex matches digits', tags: ['code'], model: 'llama3.2', sourceApp: 'VSCode' }));

    expect(existsSync(join(dir, 'e1.md'))).toBe(true);
    const hits = store.search('regex');
    expect(hits.map((h) => h.id)).toEqual(['e1']);
    expect(hits[0].tags).toEqual(['code']);
  });

  it('round-trips frontmatter (id, tags, body) through disk', () => {
    store.save(makeEntry({ id: 'e2', body: 'line one\nline two', tags: ['safari', 'note'], model: 'm', sourceApp: 'Safari' }));
    const disk = files.listDiskEntries();
    expect(disk).toHaveLength(1);
    expect(disk[0]).toMatchObject({ id: 'e2', body: 'line one\nline two', frontmatterTags: ['safari', 'note'] });
  });

  // The data-loss path end-to-end: a user edits the .md outside the app; sync must let
  // the markdown body win and refresh the index.
  it('syncFromDisk reindexes when a file is edited on disk (body wins)', () => {
    store.save(makeEntry({ id: 'e3', body: 'original', tags: ['t'], model: 'm', sourceApp: 'A' }));

    // Simulate an external edit: rewrite the file with new body + a newer mtime.
    const path = join(dir, 'e3.md');
    writeFileSync(path, serializeEntry(makeEntry({ id: 'e3', body: 'edited on disk', tags: ['t'], model: 'm', sourceApp: 'A' })), 'utf8');
    bumpMtime(path);

    const summary = store.syncFromDisk();
    expect(summary.reindexed).toBe(1);
    expect(store.search('edited').map((h) => h.id)).toEqual(['e3']);
    expect(store.search('original')).toHaveLength(0); // old body gone
  });

  it('syncFromDisk tombstones an entry whose file was deleted externally', () => {
    store.save(makeEntry({ id: 'e4', body: 'soon gone', tags: [], model: 'm', sourceApp: 'A' }));
    rmSync(join(dir, 'e4.md')); // file vanishes outside the app (e.g. user deleted the .md)

    const summary = store.syncFromDisk();
    expect(summary.tombstoned).toBe(1);
    expect(store.search('gone')).toHaveLength(0);
  });

  it('delete() removes the note from disk and the index immediately', () => {
    store.save(makeEntry({ id: 'e4b', body: 'remove me now', tags: [], model: 'm', sourceApp: 'A' }));
    expect(store.list().map((n) => n.id)).toContain('e4b');

    store.delete('e4b');

    expect(existsSync(join(dir, 'e4b.md'))).toBe(false);
    expect(store.list().map((n) => n.id)).not.toContain('e4b');
    expect(store.getBody('e4b')).toBeNull();
  });

  it('hide() then restore() round-trips a note without touching the file (undo-delete)', () => {
    store.save(makeEntry({ id: 'e4c', body: 'undo me', tags: [], model: 'm', sourceApp: 'A' }));

    store.hide('e4c');
    expect(store.list().map((n) => n.id)).not.toContain('e4c'); // hidden from the UI
    expect(store.search('undo')).toHaveLength(0);
    expect(existsSync(join(dir, 'e4c.md'))).toBe(true); // file kept for undo

    store.restore('e4c');
    expect(store.list().map((n) => n.id)).toContain('e4c'); // back in the list
    expect(store.search('undo').map((h) => h.id)).toEqual(['e4c']);
  });

  // Regression: the editor's flush-on-unmount can fire updateBody AFTER a delete tombstones the
  // note. That late edit must not resurrect it (else it flickers back, then loses those edits
  // when the pending-delete timer removes the file).
  it('updateBody after hide() does not resurrect a soft-deleted note', () => {
    store.save(makeEntry({ id: 'e4d', body: 'deleting', tags: [], model: 'm', sourceApp: 'A' }));

    store.hide('e4d');
    store.updateBody('e4d', 'a late unmount-flush edit'); // must NOT un-hide

    expect(store.list().map((n) => n.id)).not.toContain('e4d');
    expect(store.search('late')).toHaveLength(0);
  });

  it('syncFromDisk inserts a file that appeared on disk outside the app', () => {
    writeFileSync(
      join(dir, 'e5.md'),
      serializeEntry(makeEntry({ id: 'e5', body: 'dropped in by the user', tags: ['external'], model: 'm', sourceApp: 'Finder' })),
      'utf8',
    );

    const summary = store.syncFromDisk();
    expect(summary.inserted).toBe(1);
    expect(store.search('dropped').map((h) => h.id)).toEqual(['e5']);
  });

  it('syncFromDisk is a no-op when nothing changed', () => {
    store.save(makeEntry({ id: 'e6', body: 'stable', tags: [], model: 'm', sourceApp: 'A' }));
    const summary = store.syncFromDisk();
    expect(summary).toEqual({ inserted: 0, reindexed: 0, tombstoned: 0, revived: 0 });
  });

  // Pins are serialized to frontmatter; deleting/rebuilding the index from disk must recover them.
  it('preserves pinned across an index rebuild (pin survives DB delete)', () => {
    store.save(makeEntry({ id: 'p1', body: 'pinned note', tags: [], model: 'm', sourceApp: 'A', pinned: true }));

    // Simulate the DB being deleted and rebuilt from the markdown files on disk.
    const rebuilt = new NotebookStore(files, new FakeIndex());
    rebuilt.syncFromDisk();
    expect(rebuilt.list().find((n) => n.id === 'p1')?.pinned).toBe(true);
  });

  // A present-but-unparseable file must stay visible — its content is still on disk.
  it('does not tombstone a live note whose file became unparseable', () => {
    store.save(makeEntry({ id: 'u1', body: 'still here', tags: [], model: 'm', sourceApp: 'A' }));
    writeFileSync(join(dir, 'u1.md'), 'garbage without frontmatter', 'utf8'); // corrupt but present

    const summary = store.syncFromDisk();
    expect(summary.tombstoned).toBe(0);
    expect(store.list().map((n) => n.id)).toContain('u1');
  });

  // One unreadable file (here: a directory named like an entry -> readFileSync EISDIR) must not
  // abort the whole reconcile and hide every other note.
  it('isolates an unreadable file — one bad entry does not abort the reconcile', () => {
    store.save(makeEntry({ id: 'good', body: 'survivor', tags: [], model: 'm', sourceApp: 'A' }));
    mkdirSync(join(dir, 'bad.md'));

    expect(() => store.syncFromDisk()).not.toThrow();
    expect(store.search('survivor').map((h) => h.id)).toEqual(['good']);
  });

  // FTS5 MATCH throws on stray operators/quotes; search must degrade to [] for both callers.
  it('search returns [] when the index throws (bad FTS query) instead of surfacing it', () => {
    const throwing = new FakeIndex();
    throwing.search = () => { throw new Error('fts5: syntax error near ""'); };
    const s = new NotebookStore(files, throwing);
    expect(s.search('"')).toEqual([]);
  });
});

describe('NotebookStore — tags', () => {
  it('setTags persists to frontmatter (source of truth) and updates the index list', () => {
    store.save(makeEntry({ id: 't1', body: 'b', tags: ['old'], model: 'm', sourceApp: 'A' }));
    store.setTags('t1', ['alpha', 'beta']);
    expect(files.read('t1')?.tags).toEqual(['alpha', 'beta']); // written to the .md
    expect(store.list().find((n) => n.id === 't1')?.tags).toEqual(['alpha', 'beta']); // index in sync
  });

  // Regression for the esc fix: a tag containing a comma or bracket must round-trip intact
  // (the old bare comma-joined flow list corrupted these on parse).
  it('setTags round-trips a tag containing a comma / bracket through disk', () => {
    store.save(makeEntry({ id: 't2', body: 'b', tags: [], model: 'm', sourceApp: 'A' }));
    store.setTags('t2', ['a,b', 'c]d', 'e[f']);
    expect(files.read('t2')?.tags).toEqual(['a,b', 'c]d', 'e[f']);

    // And they survive a full index rebuild from the markdown files.
    const rebuilt = new NotebookStore(files, new FakeIndex());
    rebuilt.syncFromDisk();
    expect(rebuilt.list().find((n) => n.id === 't2')?.tags).toEqual(['a,b', 'c]d', 'e[f']);
  });

  it('getAllTags returns distinct live tags (deduped case-insensitively, first casing wins)', () => {
    store.save(makeEntry({ id: 'g1', body: 'b', tags: ['Code', 'Safari'], model: 'm', sourceApp: 'A' }));
    store.save(makeEntry({ id: 'g2', body: 'b', tags: ['code', 'React'], model: 'm', sourceApp: 'A' }));
    expect(store.getAllTags()).toEqual(['Code', 'React', 'Safari']);
  });

  it('getAllTags excludes tags that only live on tombstoned notes', () => {
    store.save(makeEntry({ id: 'g3', body: 'b', tags: ['only-here'], model: 'm', sourceApp: 'A' }));
    store.hide('g3');
    expect(store.getAllTags()).not.toContain('only-here');
  });

  it('list() includes each note’s tags', () => {
    store.save(makeEntry({ id: 'l1', body: 'b', tags: ['x', 'y'], model: 'm', sourceApp: 'A' }));
    expect(store.list().find((n) => n.id === 'l1')?.tags).toEqual(['x', 'y']);
  });
});

describe('NotebookStore — AI-block sidecar persistence', () => {
  const seed = (id: string) => store.save(makeEntry({ id, body: '', tags: [], model: 'm', sourceApp: 'A' }));

  it('persists AI blocks via updateBody and returns them via getAiBlocks', () => {
    seed('n1');
    store.updateBody('n1', 'body <!--ai:b1-->ans<!--/ai-->', [
      { blockId: 'b1', prompt: 'Explain', model: 'llama3.2', commandId: 'explain', selection: 'const x=1' },
    ]);
    const blocks = store.getAiBlocks('n1');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ blockId: 'b1', prompt: 'Explain', model: 'llama3.2', commandId: 'explain', selection: 'const x=1' });
    expect(typeof blocks[0].createdAt).toBe('string');
  });

  it('preserves createdAt across saves — only new blocks get a fresh timestamp', () => {
    seed('n1');
    store.updateBody('n1', 'b', [{ blockId: 'b1', prompt: 'p', model: 'm' }]);
    const first = store.getAiBlocks('n1')[0].createdAt;
    store.updateBody('n1', 'b2', [{ blockId: 'b1', prompt: 'p', model: 'm' }]);
    expect(store.getAiBlocks('n1')[0].createdAt).toBe(first);
  });

  it('drops orphaned blocks (prose deletion wins) and removes the sidecar when none remain', () => {
    seed('n1');
    store.updateBody('n1', 'b', [
      { blockId: 'b1', prompt: 'p', model: 'm' },
      { blockId: 'b2', prompt: 'p2', model: 'm' },
    ]);
    store.updateBody('n1', 'b', [{ blockId: 'b1', prompt: 'p', model: 'm' }]); // b2 removed from the doc
    expect(store.getAiBlocks('n1').map((b) => b.blockId)).toEqual(['b1']);
    store.updateBody('n1', 'b', []); // all removed
    expect(store.getAiBlocks('n1')).toEqual([]);
    expect(existsSync(join(dir, 'n1.meta.json'))).toBe(false);
  });

  it('updateBody without an aiBlocks arg leaves the sidecar untouched (body-only save)', () => {
    seed('n1');
    store.updateBody('n1', 'b', [{ blockId: 'b1', prompt: 'p', model: 'm' }]);
    store.updateBody('n1', 'b-edited'); // no blocks arg
    expect(store.getAiBlocks('n1').map((b) => b.blockId)).toEqual(['b1']);
  });

  it('delete() removes the sidecar too (no orphaned metadata)', () => {
    seed('n1');
    store.updateBody('n1', 'b', [{ blockId: 'b1', prompt: 'p', model: 'm' }]);
    expect(existsSync(join(dir, 'n1.meta.json'))).toBe(true);
    store.delete('n1');
    expect(existsSync(join(dir, 'n1.meta.json'))).toBe(false);
  });
});
