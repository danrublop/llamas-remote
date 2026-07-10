// Notebook reconcile logic (pure, no I/O).
//
// Storage model (eng review D6): each entry's markdown FILE on disk is the source of
// truth for its BODY; SQLite (FTS5) mirrors body + metadata for fast search. Because
// users own the markdown files (and may edit/delete them outside the app), the index
// can drift from disk. These pure functions decide how to reconcile a single entry,
// given the index row and the on-disk file. The actual fs/SQLite calls live in the
// caller; this module is deliberately I/O-free so every branch is unit-testable.
//
//   DISK present ─┬─ no row ............................ INSERT
//                 ├─ row tombstoned + disk newer than
//                 │   the tombstone .................... REVIVE   (genuine re-creation)
//                 ├─ row tombstoned + disk not newer ... NOOP     (undo window — stay hidden)
//                 ├─ disk newer than indexed .......... REINDEX  (markdown body wins)
//                 └─ disk not newer ................... NOOP
//   DISK absent ──┬─ row present, not tombstoned ...... TOMBSTONE
//                 └─ row tombstoned / no row .......... NOOP

export type ReconcileActionKind =
  | 'insert'
  | 'reindex'
  | 'revive'
  | 'tombstone'
  | 'noop';

/** What the SQLite index currently knows about an entry. */
export interface IndexRow {
  id: string;
  /** Tags stored in the index (authoritative for metadata, but merged with frontmatter). */
  tags: string[];
  /** File mtime (ms) captured the last time this row was indexed. */
  indexedMtimeMs: number;
  tombstoned: boolean;
  /**
   * Wall-clock ms when this row was tombstoned (hidden), or undefined if never hidden /
   * hidden by an older index that didn't record it. Soft-delete leaves the .md file on
   * disk during the undo window, so we use this to tell a genuine re-creation (file newer
   * than the tombstone → REVIVE) from a note still inside its undo window (file not newer
   * → stay hidden). See {@link reconcileEntry}.
   */
  tombstonedAtMs?: number;
}

/** Frontmatter metadata carried from disk so a rebuilt index can recover it. */
export interface DiskMeta {
  title?: string;
  model?: string;
  sourceApp?: string;
  sourceKind?: 'text' | 'image' | 'chat';
  createdAt?: string;
  imagePath?: string;
  pinned?: boolean;
}

/** What the markdown file on disk currently contains. */
export interface DiskEntry {
  id: string;
  /** Markdown body — source of truth for content. */
  body: string;
  /** Tags parsed from the file's YAML frontmatter. */
  frontmatterTags: string[];
  /** File mtime in ms. */
  mtimeMs: number;
  /** Other frontmatter (title/model/source/createdAt) so reconcile can restore it. */
  meta?: DiskMeta;
  /** File exists but couldn't be parsed — present so reconcile won't tombstone a live note. */
  unparseable?: boolean;
}

export interface ReconcileAction {
  kind: ReconcileActionKind;
  id: string;
  /** Body to write to the index (present for insert/reindex/revive). */
  body?: string;
  /** Merged tag set to write to the index (present for insert/reindex/revive). */
  tags?: string[];
  /** File mtime to record as the new indexedMtimeMs (present for insert/reindex/revive). */
  mtimeMs?: number;
  /** Frontmatter metadata to restore (present for insert/reindex/revive). */
  meta?: DiskMeta;
  /** Human-readable reason, useful for logging/observability. */
  reason: string;
}

/**
 * Merge two tag lists into a stable, de-duplicated union.
 * Order: existing `a` first (in original order), then any new tags from `b`.
 * Tags are compared case-insensitively but the first-seen casing is preserved.
 */
export function mergeTags(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of [...a, ...b]) {
    const key = tag.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(tag.trim());
  }
  return out;
}

/**
 * Decide how to reconcile one entry given its index row and on-disk file.
 * Either side may be undefined (file deleted, or never indexed).
 */
export function reconcileEntry(
  row: IndexRow | undefined,
  disk: DiskEntry | undefined,
): ReconcileAction {
  // File deleted on disk.
  if (!disk) {
    if (row && !row.tombstoned) {
      return { kind: 'tombstone', id: row.id, reason: 'markdown file removed on disk' };
    }
    const id = row?.id ?? 'unknown';
    return { kind: 'noop', id, reason: 'no file and nothing live to tombstone' };
  }

  // File is present but couldn't be parsed. Never tombstone it — the file (with content)
  // still exists on disk, so hiding it would look like data loss. Keep any existing row as-is.
  if (disk.unparseable) {
    return { kind: 'noop', id: disk.id, reason: 'file present but unparseable — keeping existing row' };
  }

  // File exists but was never indexed.
  if (!row) {
    return {
      kind: 'insert',
      id: disk.id,
      body: disk.body,
      tags: mergeTags(disk.frontmatterTags, []),
      mtimeMs: disk.mtimeMs,
      meta: disk.meta,
      reason: 'new markdown file with no index row',
    };
  }

  // A tombstoned row whose file is still on disk. Soft-delete deliberately leaves the .md
  // in place during the undo window (real removal happens ~6s later at commit), so the
  // mere presence of the file is NOT evidence the user re-created it. Only revive when the
  // file is genuinely newer than the moment we tombstoned it — otherwise a focus-resync or
  // relaunch inside the undo window would resurrect a "deleted" note. A note that was
  // actually re-created or edited on disk after deletion has a newer mtime and still revives.
  // (Rows tombstoned by an older index carry no timestamp → treat as a re-creation, the
  // prior behaviour, since by then the undo window has long passed.)
  if (row.tombstoned) {
    const REVIVE_EPSILON_MS = 1; // guard against equal-ms fs/clock ties
    const reCreated =
      row.tombstonedAtMs === undefined || disk.mtimeMs > row.tombstonedAtMs + REVIVE_EPSILON_MS;
    if (!reCreated) {
      return { kind: 'noop', id: disk.id, reason: 'tombstoned within undo window (file not newer than tombstone)' };
    }
    return {
      kind: 'revive',
      id: disk.id,
      body: disk.body,
      tags: mergeTags(row.tags, disk.frontmatterTags),
      mtimeMs: disk.mtimeMs,
      meta: disk.meta,
      reason: 'file newer than tombstone — genuine re-creation',
    };
  }

  // File is newer than what we indexed -> markdown body wins; tags merge (union).
  if (disk.mtimeMs > row.indexedMtimeMs) {
    return {
      kind: 'reindex',
      id: disk.id,
      body: disk.body,
      tags: mergeTags(row.tags, disk.frontmatterTags),
      mtimeMs: disk.mtimeMs,
      meta: disk.meta,
      reason: 'markdown newer than index (body wins, tags merged)',
    };
  }

  return { kind: 'noop', id: disk.id, reason: 'index up to date with disk' };
}

/**
 * Reconcile a full set of entries. Builds the union of ids across index + disk and
 * runs {@link reconcileEntry} for each. Returns only the actions that change state
 * (drops noops) so the caller has a tight work list.
 */
export function reconcileAll(
  rows: readonly IndexRow[],
  disk: readonly DiskEntry[],
): ReconcileAction[] {
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const diskById = new Map(disk.map((d) => [d.id, d]));
  const ids = new Set<string>([...rowById.keys(), ...diskById.keys()]);

  const actions: ReconcileAction[] = [];
  for (const id of ids) {
    const action = reconcileEntry(rowById.get(id), diskById.get(id));
    if (action.kind !== 'noop') actions.push(action);
  }
  return actions;
}
