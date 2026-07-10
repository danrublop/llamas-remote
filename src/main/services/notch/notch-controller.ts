// NotchController: the orchestration brain behind the notch panel.
//
//   capture/screenshot ─▶ pick preset ─▶ build prompt ─▶ route model ─▶ stream from LLM
//                                                                         │
//                                              save answer to notebook ◀──┘
//
// All deps are injected (capture provider, LLM client, router config, presets, notebook,
// clock/id) so the whole flow is unit-testable without Electron, Ollama, or a real model.
// The window/hotkey/renderer glue that calls this lives in main.ts (runtime).

import { routeModel, type RouterConfig } from '../router/model-router';
import { renderPrompt, canHandle, type Preset, type CaptureKind } from '../presets/presets';
import { makeEntry } from '../notebook/markdown-store';
import type { NotebookEntry } from '../notebook/types';
import type { CaptureResult } from '../capture/capture';

/** One turn in a multi-turn conversation. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Minimal LLM port. The real impl is MultiLlmClient (Ollama + OpenAI + Anthropic). */
export interface LlmClient {
  generate(opts: {
    model: string;
    prompt: string;
    imagePath?: string;
    /**
     * Multi-turn conversation history. When present, providers send the full role-tagged
     * array (chat mode) and `prompt`/`imagePath` are ignored. Absent → the single-`prompt`
     * one-shot path (notch panel + inline generation) is unchanged.
     */
    messages?: ChatMessage[];
    /** System prompt — RAG context / instructions. Only used alongside `messages`. */
    system?: string;
    /** Called with each new text chunk (a delta, NOT the cumulative answer). */
    onToken?: (delta: string) => void;
    /** Abort the in-flight request (panel closed / superseded by a newer query). */
    signal?: AbortSignal;
  }): Promise<string>;
}

export interface NotebookSink {
  save(entry: NotebookEntry): void;
}

export interface NotchControllerDeps {
  llm: LlmClient;
  notebook: NotebookSink;
  routerConfig: RouterConfig;
  presets: readonly Preset[];
  /** id + clock injected for deterministic tests. */
  newId: () => string;
  now: () => string;
}

export interface QueryRequest {
  kind: CaptureKind;
  /** Preset id, if the user tapped an action pill. */
  presetId?: string;
  /** Freeform question typed into the panel (used when no preset, or appended). */
  freeText?: string;
  /** A model the user explicitly picked, if any. */
  userSelectedModel?: string;
  /** Capture for text queries. */
  capture?: CaptureResult;
  /** Screenshot path for image queries. */
  imagePath?: string;
  /** Files the user attached, already read to text by the caller (name + content). */
  attachments?: Array<{ name: string; content: string }>;
  /** Language detected for the selection, if any (used as a tag). */
  language?: string;
  /** Stream callback for each new answer chunk (a delta, not cumulative). */
  onToken?: (delta: string) => void;
  /** Abort the in-flight generation (query superseded / notebook window closed). */
  signal?: AbortSignal;
  /**
   * Whether to save the answer as a new notebook entry. Default true (the notch flow:
   * a capture becomes its own note). The notebook's inline `/` generation sets this false
   * — the answer streams into a block INSIDE an existing note, so no separate entry is made.
   */
  persist?: boolean;
}

export interface QueryResult {
  answer: string;
  model: string;
  /** The saved entry, or undefined when `persist` was false (inline generation). */
  entry?: NotebookEntry;
}

export class NotchController {
  constructor(private readonly deps: NotchControllerDeps) {}

  /**
   * Run a query end to end and persist the answer. Throws if there is no usable input
   * (so the caller can show the "couldn't read selection — paste or type" state).
   */
  async runQuery(req: QueryRequest): Promise<QueryResult> {
    const preset = req.presetId ? this.deps.presets.find((p) => p.id === req.presetId) : undefined;
    if (req.presetId && !preset) {
      throw new Error(`Unknown preset: ${req.presetId}`);
    }
    if (preset && !canHandle(preset, req.kind)) {
      throw new Error(`Preset "${preset.id}" does not accept ${req.kind} input`);
    }

    const selection = req.capture?.text ?? '';
    // Guard on the actual user-supplied content, NOT the assembled prompt: a preset
    // renders its literal instruction text even with an empty selection, so checking the
    // prompt would let a contentless preset query (e.g. `/explain` on an empty note) slip
    // through and stream/persist a junk note. A bare image (kind:'image' + imagePath) counts.
    const hasInput = !!(
      selection.trim() ||
      req.freeText?.trim() ||
      req.attachments?.length ||
      (req.kind === 'image' && req.imagePath)
    );
    if (!hasInput) {
      throw new Error('Nothing to ask — no selection, screenshot, or question provided');
    }
    const prompt = this.buildPrompt(req, preset, selection);

    const { model } = routeModel(
      { kind: req.kind, preset, userSelectedModel: req.userSelectedModel },
      this.deps.routerConfig,
    );

    const answer = await this.deps.llm.generate({
      model,
      prompt,
      imagePath: req.kind === 'image' ? req.imagePath : undefined,
      onToken: req.onToken,
      signal: req.signal,
    });

    // Inline notebook generation streams into a block inside an existing note — no new entry.
    if (req.persist === false) {
      return { answer, model };
    }

    const entry = makeEntry({
      id: this.deps.newId(),
      title: this.buildTitle(req, preset, selection),
      body: answer,
      tags: this.buildTags(req),
      model,
      sourceApp: req.capture?.sourceApp ?? 'unknown',
      sourceKind: req.kind,
      createdAt: this.deps.now(),
      imagePath: req.kind === 'image' ? req.imagePath : undefined,
    });
    this.deps.notebook.save(entry);

    return { answer, model, entry };
  }

  private buildPrompt(req: QueryRequest, preset: Preset | undefined, selection: string): string {
    let base: string;
    if (preset) {
      base = renderPrompt(preset.promptTemplate, { selection, image: req.imagePath });
      // A typed follow-up appends to the preset prompt.
      if (req.freeText?.trim()) base = `${base}\n\n${req.freeText.trim()}`;
    } else if (req.freeText?.trim() && selection.trim()) {
      // No preset: freeform question about the selection.
      base = `${req.freeText.trim()}\n\n${selection}`;
    } else {
      // `??` only falls back on null/undefined, so an empty-string freeText would discard
      // the selection. Use `||` on the trimmed freeText so '' falls through to the selection.
      base = req.freeText?.trim() || selection;
    }
    return this.appendAttachments(base, req.attachments);
  }

  // Fold attached file contents into the prompt. Each file is fenced with its name so the
  // model can tell them apart from the selection. Counts as input on its own, so a query
  // with only attachments (no selection / question) is still valid.
  private appendAttachments(base: string, attachments?: Array<{ name: string; content: string }>): string {
    if (!attachments?.length) return base;
    const files = attachments
      .map((f) => `--- ${f.name} ---\n${f.content.trim()}`)
      .join('\n\n');
    return base.trim() ? `${base}\n\nAttached files:\n${files}` : `Attached files:\n${files}`;
  }

  private buildTitle(req: QueryRequest, preset: Preset | undefined, selection: string): string {
    const base = preset?.name ?? (req.freeText?.trim() || (req.kind === 'image' ? 'Screenshot' : 'Note'));
    const context = (selection || req.freeText || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const title = context ? `${base} — ${context}` : base;
    return title.slice(0, 70);
  }

  private buildTags(req: QueryRequest): string[] {
    const tags: string[] = [];
    if (req.capture?.sourceApp) tags.push(req.capture.sourceApp);
    if (req.language) tags.push(req.language);
    return tags;
  }
}
