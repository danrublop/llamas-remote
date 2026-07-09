// In-memory NotebookIndex fallback.
//
// Used when the native SQLite module (better-sqlite3) hasn't been rebuilt for the current
// Electron ABI yet, so the app still launches and works (search/persistence just don't
// survive a restart). Search is a naive case-insensitive substring match.

import type { IndexRow } from './reconcile';
import type { IndexUpsert, NotebookIndex, NoteSummary, SearchHit } from './types';

interface Row {
  title?: string;
  body: string;
  tags: string[];
  sourceApp?: string;
  model?: string;
  createdAt?: string;
  imagePath?: string;
  pinned: boolean;
  mtimeMs: number;
  tombstoned: boolean;
  tombstonedAtMs?: number;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function deriveTitle(title: string | undefined, body: string): string {
  if (title && title.trim()) return title.trim();
  return stripHtml(body).slice(0, 60) || 'Untitled';
}

export class MemoryNotebookIndex implements NotebookIndex {
  private rows = new Map<string, Row>();

  allRows(): IndexRow[] {
    return [...this.rows.entries()].map(([id, r]) => ({ id, tags: r.tags, indexedMtimeMs: r.mtimeMs, tombstoned: r.tombstoned, tombstonedAtMs: r.tombstonedAtMs }));
  }

  upsert(row: IndexUpsert): void {
    const prev = this.rows.get(row.id);
    this.rows.set(row.id, {
      title: row.title ?? prev?.title,
      body: row.body,
      tags: row.tags,
      sourceApp: row.sourceApp ?? prev?.sourceApp,
      model: row.model ?? prev?.model,
      createdAt: row.createdAt ?? prev?.createdAt,
      imagePath: row.imagePath ?? prev?.imagePath,
      pinned: row.pinned ?? prev?.pinned ?? false,
      mtimeMs: row.indexedMtimeMs,
      tombstoned: false,
      tombstonedAtMs: undefined,
    });
  }

  tombstone(id: string): void {
    const r = this.rows.get(id);
    if (r) { r.tombstoned = true; r.tombstonedAtMs = Date.now(); }
  }

  untombstone(id: string): void {
    const r = this.rows.get(id);
    if (r) { r.tombstoned = false; r.tombstonedAtMs = undefined; }
  }

  search(query: string): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return [...this.rows.entries()]
      .filter(([, r]) => !r.tombstoned && r.body.toLowerCase().includes(q))
      .slice(0, 50)
      .map(([id, r]) => ({ id, snippet: r.body.slice(0, 80), tags: r.tags }));
  }

  list(): NoteSummary[] {
    return [...this.rows.entries()]
      .filter(([, r]) => !r.tombstoned)
      .sort((a, b) => (Number(b[1].pinned) - Number(a[1].pinned)) || (b[1].createdAt ?? '').localeCompare(a[1].createdAt ?? ''))
      .map(([id, r]) => ({
        id,
        title: deriveTitle(r.title, r.body),
        snippet: stripHtml(r.body).slice(0, 80),
        tags: r.tags,
        sourceApp: r.sourceApp,
        model: r.model,
        imagePath: r.imagePath,
        pinned: r.pinned,
        createdAt: r.createdAt ?? '',
      }));
  }

  getAllTags(): string[] {
    const seen = new Map<string, string>();
    for (const [, r] of this.rows) {
      if (r.tombstoned) continue;
      for (const tag of r.tags) {
        const key = tag.trim().toLowerCase();
        if (key && !seen.has(key)) seen.set(key, tag.trim());
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }

  setTags(id: string, tags: string[]): void {
    const r = this.rows.get(id);
    if (r) r.tags = tags;
  }

  getBody(id: string): string | null {
    const r = this.rows.get(id);
    return r && !r.tombstoned ? r.body : null;
  }

  getImagePath(id: string): string | null {
    const r = this.rows.get(id);
    return r && !r.tombstoned ? r.imagePath ?? null : null;
  }

  setTitle(id: string, title: string): void {
    const r = this.rows.get(id);
    if (r) r.title = title;
  }

  setPinned(id: string, pinned: boolean): void {
    const r = this.rows.get(id);
    if (r) r.pinned = pinned;
  }

  updateBody(id: string, body: string): void {
    const r = this.rows.get(id);
    if (r) r.body = body;
  }
}
