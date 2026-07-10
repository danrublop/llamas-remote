import { describe, it, expect, vi } from 'vitest';
import { EmbedSync } from './embed-sync';
import type { EmbedService } from './embed-service';
import type { ChunkStore } from './chunk-store';

// Minimal in-memory fakes for the two collaborators.
function fakeStore() {
  const byNote = new Map<string, { model: string }[]>();
  return {
    embeddedNotes: (model: string) => new Set([...byNote].filter(([, cs]) => cs.some((c) => c.model === model)).map(([id]) => id)),
    replaceNote: vi.fn((noteId: string, chunks: { model: string }[]) => { byNote.set(noteId, chunks); }),
    deleteNote: vi.fn((noteId: string) => { byNote.delete(noteId); }),
    _byNote: byNote,
  } as unknown as ChunkStore & { replaceNote: ReturnType<typeof vi.fn>; deleteNote: ReturnType<typeof vi.fn>; _byNote: Map<string, unknown> };
}
const embedder = (fn: (n: number) => (Float32Array | null)[]): EmbedService =>
  ({ embed: vi.fn(async (texts: string[]) => fn(texts.length)) } as unknown as EmbedService);
const ok = () => embedder((n) => Array.from({ length: n }, () => Float32Array.from([1, 2, 3])));
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('EmbedSync', () => {
  it('backfills only notes without a current-model embedding', async () => {
    const store = fakeStore();
    store._byNote.set('already', [{ model: 'nomic' }]);
    const sync = new EmbedSync({ embedder: ok(), store, getBody: () => 'body text', listNoteIds: () => ['already', 'new1', 'new2'], model: 'nomic', sleep: async () => {} });
    sync.backfill();
    await flush();
    expect(store.replaceNote).toHaveBeenCalledTimes(2); // new1, new2 only
  });

  it('deletes chunks for an empty or removed note', async () => {
    const store = fakeStore();
    const sync = new EmbedSync({ embedder: ok(), store, getBody: () => '', listNoteIds: () => ['n'], model: 'nomic', sleep: async () => {} });
    sync.enqueue('n');
    await flush();
    expect(store.deleteNote).toHaveBeenCalledWith('n');
    sync.remove('gone');
    expect(store.deleteNote).toHaveBeenCalledWith('gone');
  });

  it('stops and re-queues when embeddings are unavailable (chat still works, RAG retries later)', async () => {
    const store = fakeStore();
    const down = embedder((n) => Array.from({ length: n }, () => null));
    const sync = new EmbedSync({ embedder: down, store, getBody: () => 'text', listNoteIds: () => ['a', 'b'], model: 'nomic', sleep: async () => {} });
    sync.backfill();
    await flush();
    expect(store.replaceNote).not.toHaveBeenCalled(); // nothing embedded while the model is down
  });
});
