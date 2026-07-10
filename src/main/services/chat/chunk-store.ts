// Persistent store for note chunk-embeddings, backing RAG's brute-force cosine search.
//
// ponytail: a single JSON file (whole-file rewrite on change), loaded into memory once. At
// personal-notebook scale (hundreds–low-thousands of chunks) this is a few MB and a full-scan
// query is sub-millisecond. Kept OUT of the native sqlite index on purpose — no schema/ABI
// surface, and it works identically on machines that fall back to the in-memory note index.
// Upgrade path if a corpus ever gets huge: sqlite BLOB column + sqlite-vec.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { Chunk } from './rag';

export interface StoredChunk { noteId: string; idx: number; text: string; vec: number[]; model: string }

export class ChunkStore {
  private chunks: StoredChunk[] = [];

  constructor(private readonly path: string) {
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (Array.isArray(parsed)) this.chunks = parsed;
      }
    } catch {
      this.chunks = []; // corrupt file → start empty; sync will re-embed
    }
  }

  private persist(): void {
    try { writeFileSync(this.path, JSON.stringify(this.chunks)); } catch { /* best effort */ }
  }

  /** Replace all chunks for a note (delete + insert), then persist. */
  replaceNote(noteId: string, chunks: Omit<StoredChunk, 'noteId'>[]): void {
    this.chunks = this.chunks.filter((c) => c.noteId !== noteId);
    for (const c of chunks) this.chunks.push({ ...c, noteId });
    this.persist();
  }

  /** Drop a note's chunks (note deleted). */
  deleteNote(noteId: string): void {
    const before = this.chunks.length;
    this.chunks = this.chunks.filter((c) => c.noteId !== noteId);
    if (this.chunks.length !== before) this.persist();
  }

  /** All chunks as rag.Chunk (vectors inflated to Float32Array). */
  all(): Chunk[] {
    return this.chunks.map((c) => ({ noteId: c.noteId, idx: c.idx, text: c.text, vec: Float32Array.from(c.vec) }));
  }

  /** Note ids already embedded with `model` — for resumable backfill (skip done notes). */
  embeddedNotes(model: string): Set<string> {
    return new Set(this.chunks.filter((c) => c.model === model).map((c) => c.noteId));
  }

  count(): number { return this.chunks.length; }
}
