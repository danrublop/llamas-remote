// Background embedding keeper: chunks + embeds notes so RAG has vectors to search.
//
//   backfill()  → enqueue every note not yet embedded with the current model (resumable)
//   enqueue(id) → (re)embed one note after an edit
//   remove(id)  → drop a deleted note's chunks
//
// A single worker drains the queue with a small throttle so a first-run backfill of hundreds of
// notes doesn't flood Ollama or block. If the embed model is unavailable mid-run, it re-queues
// the note and stops — a later trigger retries. All deps injected → no Electron in tests.

import { splitIntoChunks } from './chunker';
import type { EmbedService } from './embed-service';
import type { ChunkStore } from './chunk-store';

export interface EmbedSyncDeps {
  embedder: EmbedService;
  store: ChunkStore;
  getBody: (noteId: string) => string | null;
  listNoteIds: () => string[];
  model: string;
  /** Sleep between notes (ms) — throttle. Injected so tests run instantly. */
  sleep?: (ms: number) => Promise<void>;
}

const THROTTLE_MS = 40;

export class EmbedSync {
  private queue: string[] = [];
  private running = false;
  constructor(private readonly deps: EmbedSyncDeps) {}

  /** Enqueue notes with no current-model embedding yet (first run / after a model change). */
  backfill(): void {
    const done = this.deps.store.embeddedNotes(this.deps.model);
    for (const id of this.deps.listNoteIds()) if (!done.has(id)) this.enqueue(id);
  }

  enqueue(noteId: string): void {
    if (!this.queue.includes(noteId)) this.queue.push(noteId);
    void this.pump();
  }

  remove(noteId: string): void {
    this.queue = this.queue.filter((id) => id !== noteId);
    this.deps.store.deleteNote(noteId);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        const body = this.deps.getBody(id);
        if (!body || !body.trim()) { this.deps.store.deleteNote(id); continue; }
        const chunks = splitIntoChunks(body);
        const vecs = await this.deps.embedder.embed(chunks);
        if (vecs.some((v) => v === null)) {
          this.queue.unshift(id); // embeddings unavailable — retry this note later
          break;
        }
        this.deps.store.replaceNote(
          id,
          chunks.map((text, idx) => ({ idx, text, vec: Array.from(vecs[idx]!), model: this.deps.model })),
        );
        await sleep(THROTTLE_MS);
      }
    } finally {
      this.running = false;
    }
  }
}
