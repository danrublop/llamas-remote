// SQLite FTS5 implementation of NotebookIndex (real app only).
//
// NOT imported by tests: vitest runs under Node and better-sqlite3 is a native module
// built for the Electron ABI in the packaged app. The store's logic is tested headless
// via an in-memory fake (see notebook-store.test.ts); this file is exercised at runtime.
//
// Schema:
//   entries       canonical rows (mirrors the markdown files, incl. tombstones, title, pinned)
//   entries_fts   FTS5 over body + tags, kept in sync manually; tombstoned rows removed.

import Database from 'better-sqlite3';
import type { IndexRow } from './reconcile';
import type { IndexUpsert, NotebookIndex, NoteSummary, SearchHit } from './types';

const CREATE_ENTRIES = `
  CREATE TABLE IF NOT EXISTS entries (
    id TEXT PRIMARY KEY,
    title TEXT,
    body TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    model TEXT,
    source_app TEXT,
    source_kind TEXT,
    created_at TEXT,
    image_path TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    indexed_mtime_ms REAL NOT NULL DEFAULT 0,
    tombstoned INTEGER NOT NULL DEFAULT 0,
    tombstoned_at_ms REAL NOT NULL DEFAULT 0
  )`;

const CREATE_FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(id UNINDEXED, body, tags)`;

// Backs the sidebar list()/allRows scan (filter tombstoned, order pinned then newest) so
// returning ALL live notes stays cheap without a row cap.
const CREATE_LIST_INDEX = `CREATE INDEX IF NOT EXISTS idx_entries_list ON entries(tombstoned, pinned DESC, created_at DESC)`;

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function deriveTitle(title: string | null, body: string): string {
  if (title && title.trim()) return title.trim();
  return stripHtml(body).slice(0, 60) || 'Untitled';
}

export class SqliteNotebookIndex implements NotebookIndex {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.prepare(CREATE_ENTRIES).run();
    this.db.prepare(CREATE_FTS).run();
    this.migrate();
    this.db.prepare(CREATE_LIST_INDEX).run();
  }

  // Add any columns missing from an older `entries` table (CREATE TABLE IF NOT EXISTS
  // won't alter an existing table, so DBs created before title/pinned were added break).
  private migrate(): void {
    const cols = new Set(
      (this.db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>).map((r) => r.name),
    );
    const ensure = (name: string, ddl: string) => {
      if (!cols.has(name)) this.db.prepare(`ALTER TABLE entries ADD COLUMN ${ddl}`).run();
    };
    ensure('title', 'title TEXT');
    ensure('model', 'model TEXT');
    ensure('source_app', 'source_app TEXT');
    ensure('source_kind', 'source_kind TEXT');
    ensure('created_at', 'created_at TEXT');
    ensure('image_path', 'image_path TEXT');
    ensure('pinned', 'pinned INTEGER NOT NULL DEFAULT 0');
    ensure('indexed_mtime_ms', 'indexed_mtime_ms REAL NOT NULL DEFAULT 0');
    ensure('tombstoned', 'tombstoned INTEGER NOT NULL DEFAULT 0');
    ensure('tombstoned_at_ms', 'tombstoned_at_ms REAL NOT NULL DEFAULT 0');
  }

  allRows(): IndexRow[] {
    const rows = this.db
      .prepare('SELECT id, tags, indexed_mtime_ms AS m, tombstoned, tombstoned_at_ms AS tat FROM entries')
      .all() as Array<{ id: string; tags: string; m: number; tombstoned: number; tat: number }>;
    return rows.map((r) => ({
      id: r.id,
      tags: safeParseTags(r.tags),
      indexedMtimeMs: r.m,
      tombstoned: r.tombstoned === 1,
      // 0 means "unknown / never recorded" — leave it undefined so reconcile treats it as a
      // legacy tombstone (revive) rather than a tombstone at the epoch.
      tombstonedAtMs: r.tat > 0 ? r.tat : undefined,
    }));
  }

  upsert(row: IndexUpsert): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          // On conflict, tombstone state is preserved (NOT cleared): an in-app edit that lands
          // after a soft-delete (e.g. the editor's flush-on-unmount racing a delete) must not
          // resurrect the note. Reconcile's revive untombstones explicitly instead.
          `INSERT INTO entries (id, title, body, tags, model, source_app, source_kind, created_at, image_path, pinned, indexed_mtime_ms, tombstoned, tombstoned_at_ms)
           VALUES (@id, @title, @body, @tags, @model, @source_app, @source_kind, @created_at, @image_path, COALESCE(@pinned, 0), @mtime, 0, 0)
           ON CONFLICT(id) DO UPDATE SET
             body=@body, tags=@tags, indexed_mtime_ms=@mtime,
             title=COALESCE(@title, entries.title),
             pinned=COALESCE(@pinned, entries.pinned),
             model=COALESCE(@model, entries.model),
             source_app=COALESCE(@source_app, entries.source_app),
             source_kind=COALESCE(@source_kind, entries.source_kind),
             created_at=COALESCE(@created_at, entries.created_at),
             image_path=COALESCE(@image_path, entries.image_path)`,
        )
        .run({
          id: row.id,
          title: row.title ?? null,
          body: row.body,
          tags: JSON.stringify(row.tags),
          model: row.model ?? null,
          source_app: row.sourceApp ?? null,
          source_kind: row.sourceKind ?? null,
          created_at: row.createdAt ?? null,
          image_path: row.imagePath ?? null,
          pinned: row.pinned === undefined ? null : row.pinned ? 1 : 0,
          mtime: row.indexedMtimeMs,
        });
      this.db.prepare('DELETE FROM entries_fts WHERE id = ?').run(row.id);
      this.db.prepare('INSERT INTO entries_fts (id, body, tags) VALUES (?, ?, ?)').run(row.id, row.body, row.tags.join(' '));
    });
    tx();
  }

  tombstone(id: string): void {
    const tx = this.db.transaction(() => {
      // Record WHEN we hid the row. Soft-delete leaves the .md on disk during the undo
      // window, so reconcile compares this against the file's mtime to avoid resurrecting a
      // note whose file simply hasn't been removed yet (see reconcileEntry).
      this.db.prepare('UPDATE entries SET tombstoned = 1, tombstoned_at_ms = ? WHERE id = ?').run(Date.now(), id);
      this.db.prepare('DELETE FROM entries_fts WHERE id = ?').run(id);
    });
    tx();
  }

  // Reverse a tombstone: the entries row still holds body/tags, so we clear the flag and
  // rebuild the FTS row from it. Used by undo-delete (file is still on disk).
  untombstone(id: string): void {
    const tx = this.db.transaction(() => {
      const row = this.db.prepare('SELECT body, tags FROM entries WHERE id = ?').get(id) as { body: string; tags: string } | undefined;
      if (!row) return;
      this.db.prepare('UPDATE entries SET tombstoned = 0, tombstoned_at_ms = 0 WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM entries_fts WHERE id = ?').run(id);
      this.db.prepare('INSERT INTO entries_fts (id, body, tags) VALUES (?, ?, ?)').run(id, row.body, safeParseTags(row.tags).join(' '));
    });
    tx();
  }

  search(query: string): SearchHit[] {
    // Sanitize into a safe FTS5 query: tokenize on word chars, quote each token (so FTS5
    // syntax like " ( ) * : - AND/OR can't trigger a syntax error), prefix-match each.
    const tokens = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (tokens.length === 0) return [];
    const fts = tokens.map((t) => `"${t}"*`).join(' ');
    const rows = this.db
      .prepare(
        `SELECT f.id AS id, snippet(entries_fts, 1, '[', ']', '…', 10) AS snippet, e.tags AS tags
         FROM entries_fts f JOIN entries e ON e.id = f.id
         WHERE entries_fts MATCH ? AND e.tombstoned = 0
         ORDER BY rank LIMIT 50`,
      )
      .all(fts) as Array<{ id: string; snippet: string; tags: string }>;
    return rows.map((r) => ({ id: r.id, snippet: r.snippet, tags: safeParseTags(r.tags) }));
  }

  list(): NoteSummary[] {
    // No row cap: this backs the whole sidebar/note tree + folder counts + the search
    // title-map, so every live note must be returned. Past a fixed LIMIT, overflow notes
    // silently vanished from the UI even though their .md files were intact. (idx_entries_list
    // keeps this ordered scan cheap; the real search path stays capped in search().)
    const rows = this.db
      .prepare(
        `SELECT id, title, body, tags, source_app AS sourceApp, model, image_path AS imagePath, pinned, created_at AS createdAt
         FROM entries WHERE tombstoned = 0
         ORDER BY pinned DESC, created_at DESC`,
      )
      .all() as Array<{ id: string; title: string | null; body: string; tags: string; sourceApp: string | null; model: string | null; imagePath: string | null; pinned: number; createdAt: string | null }>;
    return rows.map((r) => ({
      id: r.id,
      title: deriveTitle(r.title, r.body),
      snippet: stripHtml(r.body).slice(0, 80),
      tags: safeParseTags(r.tags),
      sourceApp: r.sourceApp ?? undefined,
      model: r.model ?? undefined,
      imagePath: r.imagePath ?? undefined,
      pinned: r.pinned === 1,
      createdAt: r.createdAt ?? '',
    }));
  }

  // Distinct tags over live notes. Deduped case-insensitively (first-seen casing wins) and
  // sorted for a stable filter list. Backs notebook:all-tags.
  getAllTags(): string[] {
    const rows = this.db
      .prepare('SELECT tags FROM entries WHERE tombstoned = 0')
      .all() as Array<{ tags: string }>;
    const seen = new Map<string, string>();
    for (const r of rows) {
      for (const tag of safeParseTags(r.tags)) {
        const key = tag.trim().toLowerCase();
        if (key && !seen.has(key)) seen.set(key, tag.trim());
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }

  // Replace a note's tag set in the index and rebuild its FTS row (tags are an indexed
  // column). Mirrors updateBody's FTS-refresh pattern. Used as the store's fallback when a
  // note has no file on disk; the normal path persists via upsert.
  setTags(id: string, tags: string[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE entries SET tags = ? WHERE id = ?').run(JSON.stringify(tags), id);
      const body = (this.db.prepare('SELECT body FROM entries WHERE id = ?').get(id) as { body: string } | undefined)?.body;
      if (body === undefined) return;
      this.db.prepare('DELETE FROM entries_fts WHERE id = ?').run(id);
      this.db.prepare('INSERT INTO entries_fts (id, body, tags) VALUES (?, ?, ?)').run(id, body, tags.join(' '));
    });
    tx();
  }

  getBody(id: string): string | null {
    const row = this.db.prepare('SELECT body FROM entries WHERE id = ? AND tombstoned = 0').get(id) as { body: string } | undefined;
    return row?.body ?? null;
  }

  getImagePath(id: string): string | null {
    const row = this.db.prepare('SELECT image_path AS p FROM entries WHERE id = ? AND tombstoned = 0').get(id) as { p: string | null } | undefined;
    return row?.p ?? null;
  }

  setTitle(id: string, title: string): void {
    this.db.prepare('UPDATE entries SET title = ? WHERE id = ?').run(title, id);
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.prepare('UPDATE entries SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id);
  }

  updateBody(id: string, body: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE entries SET body = ? WHERE id = ?').run(body, id);
      const tags = (this.db.prepare('SELECT tags FROM entries WHERE id = ?').get(id) as { tags: string } | undefined)?.tags ?? '[]';
      this.db.prepare('DELETE FROM entries_fts WHERE id = ?').run(id);
      this.db.prepare('INSERT INTO entries_fts (id, body, tags) VALUES (?, ?, ?)').run(id, body, safeParseTags(tags).join(' '));
    });
    tx();
  }

  close(): void {
    this.db.close();
  }
}

function safeParseTags(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}
