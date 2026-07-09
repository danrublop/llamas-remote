import { describe, it, expect } from 'vitest';
import {
  reconcileEntry,
  reconcileAll,
  mergeTags,
  type IndexRow,
  type DiskEntry,
} from './reconcile';

const row = (over: Partial<IndexRow> = {}): IndexRow => ({
  id: 'e1',
  tags: [],
  indexedMtimeMs: 1000,
  tombstoned: false,
  ...over,
});

const disk = (over: Partial<DiskEntry> = {}): DiskEntry => ({
  id: 'e1',
  body: 'hello',
  frontmatterTags: [],
  mtimeMs: 1000,
  ...over,
});

describe('mergeTags', () => {
  it('unions, dedups case-insensitively, preserves first-seen casing and order', () => {
    expect(mergeTags(['Code', 'safari'], ['CODE', 'pdf'])).toEqual(['Code', 'safari', 'pdf']);
  });

  it('drops empty/whitespace tags', () => {
    expect(mergeTags(['a', '  ', ''], [' b '])).toEqual(['a', 'b']);
  });

  it('handles empty inputs', () => {
    expect(mergeTags([], [])).toEqual([]);
  });
});

describe('reconcileEntry', () => {
  it('inserts a new file with no index row', () => {
    const a = reconcileEntry(undefined, disk({ body: 'new', frontmatterTags: ['x'] }));
    expect(a.kind).toBe('insert');
    expect(a.body).toBe('new');
    expect(a.tags).toEqual(['x']);
    expect(a.mtimeMs).toBe(1000);
  });

  // Metadata must survive an index rebuild (e.g. fresh install) — carried from frontmatter.
  it('carries frontmatter metadata (incl. pinned) on insert/reindex/revive', () => {
    const meta = { title: 'My note', model: 'mistral:latest', sourceApp: 'Safari', sourceKind: 'text' as const, createdAt: '2026-05-25T00:00:00Z', pinned: true };
    expect(reconcileEntry(undefined, disk({ meta })).meta).toEqual(meta);
    expect(reconcileEntry(row({ indexedMtimeMs: 1000 }), disk({ mtimeMs: 2000, meta })).meta).toEqual(meta); // reindex
    expect(reconcileEntry(row({ tombstoned: true }), disk({ meta })).meta).toEqual(meta); // revive
  });

  // A present-but-unparseable file must never be tombstoned — the file (with content) is still
  // on disk, so hiding it would look like data loss.
  it('keeps the existing row for a present-but-unparseable file (no tombstone)', () => {
    expect(reconcileEntry(row({ tombstoned: false }), disk({ unparseable: true })).kind).toBe('noop');
    expect(reconcileEntry(undefined, disk({ unparseable: true })).kind).toBe('noop');
  });

  // The data-loss path the eng review flagged: when the markdown is newer, the
  // markdown BODY must win and overwrite the index — never the other way around.
  it('reindexes with markdown body winning when disk is newer', () => {
    const a = reconcileEntry(
      row({ tags: ['old'], indexedMtimeMs: 1000 }),
      disk({ body: 'edited on disk', frontmatterTags: ['new'], mtimeMs: 2000 }),
    );
    expect(a.kind).toBe('reindex');
    expect(a.body).toBe('edited on disk'); // body wins
    expect(a.tags).toEqual(['old', 'new']); // tags merge (union)
    expect(a.mtimeMs).toBe(2000);
  });

  it('does nothing when the index is already current', () => {
    expect(reconcileEntry(row({ indexedMtimeMs: 2000 }), disk({ mtimeMs: 2000 })).kind).toBe('noop');
    expect(reconcileEntry(row({ indexedMtimeMs: 2000 }), disk({ mtimeMs: 1500 })).kind).toBe('noop');
  });

  it('tombstones a live row when the file disappears', () => {
    const a = reconcileEntry(row({ tombstoned: false }), undefined);
    expect(a.kind).toBe('tombstone');
    expect(a.id).toBe('e1');
  });

  it('does not re-tombstone an already-tombstoned row with no file', () => {
    expect(reconcileEntry(row({ tombstoned: true }), undefined).kind).toBe('noop');
  });

  it('revives a tombstoned entry (legacy row, no tombstone timestamp) when its file reappears', () => {
    const a = reconcileEntry(
      row({ tombstoned: true, tags: ['kept'] }),
      disk({ body: 'back', frontmatterTags: ['fresh'], mtimeMs: 3000 }),
    );
    expect(a.kind).toBe('revive');
    expect(a.body).toBe('back');
    expect(a.tags).toEqual(['kept', 'fresh']);
    expect(a.mtimeMs).toBe(3000);
  });

  // Undo window: soft-delete tombstones the row but leaves the .md on disk (real removal is
  // ~6s later at commit). A focus-resync/relaunch inside that window must NOT resurrect it —
  // the file's mtime is older than the tombstone, so it stays hidden.
  it('does NOT revive a tombstoned entry whose file is not newer than the tombstone (undo window)', () => {
    const a = reconcileEntry(
      row({ tombstoned: true, tombstonedAtMs: 5000 }),
      disk({ body: 'still on disk', mtimeMs: 4000 }), // file older than the tombstone
    );
    expect(a.kind).toBe('noop');
  });

  it('does NOT revive when file mtime equals the tombstone time (epsilon guard)', () => {
    const a = reconcileEntry(
      row({ tombstoned: true, tombstonedAtMs: 5000 }),
      disk({ mtimeMs: 5000 }),
    );
    expect(a.kind).toBe('noop');
  });

  // The legitimate case must still work: a note actually re-created / edited on disk after
  // deletion has a newer mtime than the tombstone, so it revives.
  it('revives a tombstoned entry re-created on disk after deletion (file newer than tombstone)', () => {
    const a = reconcileEntry(
      row({ tombstoned: true, tombstonedAtMs: 5000, tags: ['kept'] }),
      disk({ body: 'recreated', frontmatterTags: ['fresh'], mtimeMs: 9000 }),
    );
    expect(a.kind).toBe('revive');
    expect(a.body).toBe('recreated');
    expect(a.tags).toEqual(['kept', 'fresh']);
    expect(a.mtimeMs).toBe(9000);
  });

  it('noops when there is neither a file nor a row', () => {
    expect(reconcileEntry(undefined, undefined).kind).toBe('noop');
  });
});

describe('reconcileAll', () => {
  it('builds the union of ids and drops noops', () => {
    const rows: IndexRow[] = [
      row({ id: 'current', indexedMtimeMs: 5000 }),
      row({ id: 'gone', indexedMtimeMs: 5000 }),
    ];
    const disks: DiskEntry[] = [
      disk({ id: 'current', mtimeMs: 5000 }), // noop, dropped
      disk({ id: 'fresh', mtimeMs: 100 }), // insert
      // 'gone' has no file -> tombstone
    ];
    const actions = reconcileAll(rows, disks);
    const byId = Object.fromEntries(actions.map((a) => [a.id, a.kind]));
    expect(byId).toEqual({ fresh: 'insert', gone: 'tombstone' });
    expect(actions.find((a) => a.id === 'current')).toBeUndefined();
  });
});
