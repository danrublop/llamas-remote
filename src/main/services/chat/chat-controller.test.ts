import { describe, it, expect, vi } from 'vitest';
import { ChatController, type ChatStore, type RagRetriever } from './chat-controller';
import { parseTranscript } from './chat-transcript';
import type { LlmClient } from '../notch/notch-controller';

function fakeStore(initial = ''): ChatStore & { body: string } {
  return {
    body: initial,
    getBody(_id) { return this.body; },
    updateBody(_id, body) { this.body = body; },
  };
}

const okLlm = (answer = 'the answer'): LlmClient => ({
  generate: vi.fn(async (opts) => { opts.onToken?.(answer); return answer; }),
});

const deps = (over: Partial<{ llm: LlmClient; store: ChatStore; retrieve?: RagRetriever }> = {}) => ({
  llm: over.llm ?? okLlm(),
  store: over.store ?? fakeStore(),
  now: () => '2026-07-09T00:00:00Z',
  retrieve: over.retrieve,
});

describe('ChatController.sendTurn', () => {
  it('appends user + assistant turns and persists the transcript', async () => {
    const store = fakeStore();
    const c = new ChatController(deps({ store }));
    await c.sendTurn({ noteId: 'n1', text: 'hello', model: 'mistral', useRag: false });
    const turns = parseTranscript(store.body);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[0].content).toBe('hello');
    expect(turns[1].content).toBe('the answer');
    expect(turns[1].model).toBe('mistral');
  });

  it('sends prior history as messages (multi-turn)', async () => {
    const llm = okLlm();
    const store = fakeStore('<!--chat:user-->\nq1\n\n<!--chat:assistant model="m"-->\na1');
    const c = new ChatController(deps({ llm, store }));
    await c.sendTurn({ noteId: 'n1', text: 'q2', model: 'm', useRag: false });
    const sent = vi.mocked(llm.generate).mock.calls[0][0].messages!;
    expect(sent.map((m) => m.content)).toEqual(['q1', 'a1', 'q2']);
  });

  it('keeps the user turn but writes no assistant turn when generation is cancelled', async () => {
    const store = fakeStore();
    const llm: LlmClient = { generate: vi.fn(async () => { throw new Error('cancelled'); }) };
    const c = new ChatController(deps({ llm, store }));
    await expect(c.sendTurn({ noteId: 'n1', text: 'hi', model: 'm', useRag: false })).rejects.toThrow('cancelled');
    const turns = parseTranscript(store.body);
    expect(turns.map((t) => t.role)).toEqual(['user']); // user saved, no partial assistant
  });

  it('applies RAG system + citations and excludes the chat itself', async () => {
    const llm = okLlm();
    const retrieve: RagRetriever = {
      retrieve: vi.fn(async () => ({ system: '<user_notes>note text</user_notes>', citations: ['noteA'] })),
    };
    const store = fakeStore();
    const c = new ChatController(deps({ llm, store, retrieve }));
    await c.sendTurn({ noteId: 'chat1', text: 'what do my notes say?', model: 'm', useRag: true });
    expect(vi.mocked(retrieve.retrieve).mock.calls[0][1]).toEqual({ excludeNoteId: 'chat1' });
    expect(vi.mocked(llm.generate).mock.calls[0][0].system).toContain('<user_notes>');
    expect(parseTranscript(store.body)[1].cites).toEqual(['noteA']);
  });

  it('skips RAG when useRag is false', async () => {
    const retrieve: RagRetriever = { retrieve: vi.fn() };
    const c = new ChatController(deps({ retrieve }));
    await c.sendTurn({ noteId: 'n', text: 'hi', model: 'm', useRag: false });
    expect(retrieve.retrieve).not.toHaveBeenCalled();
  });
});
