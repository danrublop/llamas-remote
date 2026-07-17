// ChatController: one chat turn end-to-end.
//
//   load transcript ─▶ append user turn (persist now) ─▶ [RAG retrieve] ─▶ stream from LLM
//                                                                             │
//                                        append assistant turn + persist ◀────┘
//
// The markdown transcript (parsed via chat-transcript) is the source of truth; each turn is
// persisted through the injected store (NotebookStore.updateBody in production). All deps are
// injected so the whole flow is unit-testable without Electron, Ollama, or a real model.

import type { LlmClient, ChatMessage } from '../notch/notch-controller';
import { parseTranscript, serializeTranscript, type ChatTurn } from './chat-transcript';

export interface ChatStore {
  getBody(id: string): string | null;
  updateBody(id: string, body: string): void;
}

/** RAG (wired in step 5). Returns a ready-to-send system prompt + the note ids it cited. */
export interface RagRetriever {
  retrieve(query: string, opts: { excludeNoteId: string }): Promise<{ system: string; citations: string[] } | null>;
}

export interface ChatControllerDeps {
  llm: LlmClient;
  store: ChatStore;
  now: () => string;
  retrieve?: RagRetriever; // absent → plain multi-turn chat (no note context)
}

// Keep the sent history under a rough char budget (no tokenizer exists — see the notch
// context meter's same heuristic). Trim oldest turns first, always keep the latest.
const HISTORY_CHAR_BUDGET = 8000;
function toMessages(turns: ChatTurn[]): ChatMessage[] {
  const msgs: ChatMessage[] = turns.map((t) => ({ role: t.role, content: t.content }));
  let total = msgs.reduce((n, m) => n + m.content.length, 0);
  while (total > HISTORY_CHAR_BUDGET && msgs.length > 1) {
    total -= msgs.shift()!.content.length;
  }
  return msgs;
}

export class ChatController {
  constructor(private readonly deps: ChatControllerDeps) {}

  async sendTurn(opts: {
    noteId: string;
    text: string;
    model: string;
    useRag: boolean;
    /** Instructions to put ahead of any retrieved context — the agent's tools (see main.ts). */
    systemPrefix?: string;
    onToken?: (delta: string) => void;
    signal?: AbortSignal;
  }): Promise<{ answer: string; citations: string[] }> {
    const { noteId, text, model, useRag, systemPrefix, onToken, signal } = opts;
    const turns = parseTranscript(this.deps.store.getBody(noteId) ?? '');

    // Persist the user turn immediately, so a cancelled/failed generation still leaves the
    // message in the transcript (like a sent chat message awaiting a reply).
    turns.push({ role: 'user', content: text, ts: this.deps.now() });
    this.deps.store.updateBody(noteId, serializeTranscript(turns));

    // RAG: retrieve context for the user's message, excluding this chat's own note (so a chat
    // never feeds itself its own transcript). The retriever wraps note text as untrusted data.
    let ragSystem: string | undefined;
    let citations: string[] = [];
    if (useRag && this.deps.retrieve) {
      const r = await this.deps.retrieve.retrieve(text, { excludeNoteId: noteId });
      if (r) { ragSystem = r.system; citations = r.citations; }
    }
    // Tools first, retrieved notes after: the notes are untrusted data, so anything in them that
    // looks like an instruction arrives already framed by the real instructions.
    const system = [systemPrefix, ragSystem].filter(Boolean).join('\n\n') || undefined;

    // Throws on cancel ('cancelled') or error — the user turn is already saved, and we do NOT
    // append a partial assistant turn.
    const answer = await this.deps.llm.generate({ model, prompt: text, messages: toMessages(turns), system, onToken, signal });

    turns.push({ role: 'assistant', content: answer, model, cites: citations.length ? citations : undefined, ts: this.deps.now() });
    this.deps.store.updateBody(noteId, serializeTranscript(turns));
    return { answer, citations };
  }
}
