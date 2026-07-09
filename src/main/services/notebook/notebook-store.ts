// Notebook store: orchestrates the markdown source-of-truth + the search index.
//
//   save(entry)      -> write <id>.md, upsert the index row (mtime recorded)
//   syncFromDisk()   -> reconcile index against disk (drives the tested reconcileAll):
//                       insert new files, reindex edited ones (body wins), tombstone
//                       deleted ones, revive re-created ones
//   search(query)    -> delegate to the index
//
// All decision logic lives in reconcile.ts (pure, tested). This file only does I/O
// orchestration, so it stays thin.

import { statSync } from 'fs';
import { reconcileAll } from './reconcile';
import type { MarkdownStore } from './markdown-store';
import type { AIBlockMeta } from './sidecar';
import type { NotebookEntry, NotebookIndex, NoteSummary, SearchHit } from './types';

export interface SyncSummary {
  inserted: number;
  reindexed: number;
  tombstoned: number;
  revived: number;
}

export class NotebookStore {
  constructor(
    private readonly files: MarkdownStore,
    private readonly index: NotebookIndex,
  ) {}

  /** Persist a new/edited entry: write the file, then mirror it into the index. */
  save(entry: NotebookEntry): void {
    this.persist(entry);
  }

  // Write the entry's markdown file (source of truth) and upsert the index with the
  // freshly-written file's mtime + all metadata. Used by save and every in-app mutation,
  // so the file's frontmatter (model/source_kind/created_at) is never clobbered and the
  // index mtime stays in lockstep with disk (no spurious reindex on next launch).
  private persist(entry: NotebookEntry): void {
    // If a capture image was attached (temp path), copy it into the notebook and point the
    // entry at the stored copy before writing.
    let imagePath = entry.imagePath;
    if (imagePath) {
      try { imagePath = this.files.storeImage(entry.id, imagePath); } catch (e) { console.warn('storeImage failed:', e); }
    }
    const toWrite = { ...entry, imagePath };
    const path = this.files.write(toWrite);
    const mtimeMs = statSync(path).mtimeMs;
    this.index.upsert({
      id: toWrite.id,
      title: toWrite.title,
      body: toWrite.body,
      tags: toWrite.tags,
      model: toWrite.model,
      sourceApp: toWrite.sourceApp,
      sourceKind: toWrite.sourceKind,
      pinned: toWrite.pinned,
      createdAt: toWrite.createdAt,
      imagePath,
      indexedMtimeMs: mtimeMs,
    });
  }

  /** Absolute path to a note's capture image, or null. */
  getImagePath(id: string): string | null {
    return this.index.getImagePath(id);
  }

  /** Notes for the sidebar (pinned first, newest next). */
  list(): NoteSummary[] {
    return this.index.list();
  }

  /** Full body of a note. */
  getBody(id: string): string | null {
    return this.index.getBody(id);
  }

  /** Rename a note (preserves all other fields on disk + index). */
  rename(id: string, title: string): void {
    const e = this.files.read(id);
    if (e) this.persist({ ...e, title });
    else this.index.setTitle(id, title);
  }

  /** Pin/unpin a note. */
  setPinned(id: string, pinned: boolean): void {
    const e = this.files.read(id);
    if (e) this.persist({ ...e, pinned });
    else this.index.setPinned(id, pinned);
  }

  /** Replace a note's tags: frontmatter is the source of truth, so persist to the .md
      (which reindexes with the new tags) — mirroring rename/setPinned. */
  setTags(id: string, tags: string[]): void {
    const e = this.files.read(id);
    if (e) this.persist({ ...e, tags });
    else this.index.setTags(id, tags);
  }

  /** Distinct tags across all live notes (for the tag filter / autocomplete). */
  getAllTags(): string[] {
    return this.index.getAllTags();
  }

  /**
   * Update a note body from an in-app edit (preserves metadata + refreshes mtime). When
   * `aiBlocks` is supplied, the AI-block sidecar is rewritten from it (the live doc is
   * authoritative for which blocks exist, so this prunes orphaned metadata).
   */
  updateBody(id: string, body: string, aiBlocks?: Array<Omit<AIBlockMeta, 'createdAt'>>): void {
    const e = this.files.read(id);
    if (e) this.persist({ ...e, body });
    else this.index.updateBody(id, body);
    if (aiBlocks) this.setAiBlocks(id, aiBlocks);
  }

  /** AI-block metadata for a note (for reconstructing the blocks on load). */
  getAiBlocks(id: string): AIBlockMeta[] {
    return this.files.readAiBlocks(id);
  }

  // Merge incoming blocks with the existing sidecar so each block's createdAt is preserved
  // across saves (only new blocks get a fresh timestamp), then persist. Blocks absent from
  // `incoming` are dropped — the prose (live doc) wins on existence.
  private setAiBlocks(id: string, incoming: Array<Omit<AIBlockMeta, 'createdAt'>>): void {
    const existing = new Map(this.files.readAiBlocks(id).map((b) => [b.blockId, b]));
    const merged: AIBlockMeta[] = incoming.map((b) => ({
      ...b,
      createdAt: existing.get(b.blockId)?.createdAt ?? new Date().toISOString(),
    }));
    this.files.writeAiBlocks(id, merged);
  }

  /** Hide a note from list/search without deleting the file yet — the reversible first
      step of a delete (paired with restore for undo, or delete to commit). */
  hide(id: string): void {
    this.index.tombstone(id);
  }

  /** Undo a hide: bring the note back into list/search (its file was never removed). */
  restore(id: string): void {
    this.index.untombstone(id);
  }

  /** Delete an entry: remove the markdown file and tombstone the index row immediately
      (so the UI reflects it without waiting for the next syncFromDisk). Commits a hide. */
  delete(id: string): void {
    this.files.delete(id);
    this.index.tombstone(id);
  }

  /**
   * Reconcile the index against the on-disk markdown files. Run on launch and whenever
   * files may have changed underneath us (user edited/synced/deleted .md files).
   */
  syncFromDisk(): SyncSummary {
    const rows = this.index.allRows();
    const disk = this.files.listDiskEntries();
    const actions = reconcileAll(rows, disk);

    const summary: SyncSummary = { inserted: 0, reindexed: 0, tombstoned: 0, revived: 0 };
    for (const action of actions) {
      switch (action.kind) {
        case 'insert':
        case 'reindex':
        case 'revive': {
          this.index.upsert({
            id: action.id,
            body: action.body ?? '',
            tags: action.tags ?? [],
            indexedMtimeMs: action.mtimeMs ?? 0,
            // Restore frontmatter metadata so a rebuilt index keeps titles/models/etc.
            title: action.meta?.title,
            model: action.meta?.model,
            sourceApp: action.meta?.sourceApp,
            sourceKind: action.meta?.sourceKind,
            createdAt: action.meta?.createdAt,
            imagePath: action.meta?.imagePath,
            pinned: action.meta?.pinned,
          });
          if (action.kind === 'insert') summary.inserted++;
          else if (action.kind === 'reindex') summary.reindexed++;
          else summary.revived++;
          break;
        }
        case 'tombstone': {
          this.index.tombstone(action.id);
          summary.tombstoned++;
          break;
        }
      }
    }
    return summary;
  }

  search(query: string): SearchHit[] {
    // FTS5 MATCH throws a syntax error on stray operators/quotes in raw user input (a bare `"`,
    // `AND`, etc). Guard here so both callers (notebook:search + panel:search) degrade to no
    // results instead of surfacing an error.
    try {
      return this.index.search(query);
    } catch (e) {
      console.warn('search failed for query', JSON.stringify(query), e);
      return [];
    }
  }
}
