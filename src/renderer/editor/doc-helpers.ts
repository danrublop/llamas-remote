// Doc helpers for AI-block streaming. Pure ProseMirror/TipTap doc operations, separated
// from the React component so they can be unit-tested headlessly (jsdom) without rendering.

import { Editor } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { notebookExtensions } from './extensions';
import type { AIBlockMeta } from '../../main/services/notebook/sidecar';

export interface AiBlockHit {
  pos: number;
  /** The node's size (so callers can compute the inner content range). */
  nodeSize: number;
  attrs: Record<string, unknown>;
}

/** Find an aiBlock node by its blockId. Returns its document position + size, or null. */
export function findAiBlock(editor: Editor, blockId: string): AiBlockHit | null {
  let hit: AiBlockHit | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (hit) return false;
    if (node.type.name === 'aiBlock' && node.attrs.blockId === blockId) {
      hit = { pos, nodeSize: node.nodeSize, attrs: { ...node.attrs } };
      return false;
    }
    return true;
  });
  return hit;
}

/**
 * Replace an aiBlock's entire content with `text` as a single paragraph. Used while
 * streaming: callers pass the CUMULATIVE answer so far (not deltas), so the block always
 * shows the full current text. No-op if the block isn't found (it was deleted mid-stream —
 * matches the bridge's "drop tokens for a gone block" rule). Returns whether it applied.
 */
export function setAiBlockText(editor: Editor, blockId: string, text: string): boolean {
  const hit = findAiBlock(editor, blockId);
  if (!hit) return false;
  const { state, view } = editor;
  const inner = text.length ? [state.schema.node('paragraph', null, state.schema.text(text))] : [state.schema.node('paragraph')];
  const fragmentStart = hit.pos + 1; // inside the aiBlock
  const fragmentEnd = hit.pos + hit.nodeSize - 1;
  const tr = state.tr.replaceWith(fragmentStart, fragmentEnd, inner);
  tr.setMeta('addToHistory', false); // streaming updates shouldn't spam undo history
  view.dispatch(tr);
  return true;
}

/**
 * Parse a Markdown string into block-level JSON content using the notebook schema.
 * A throwaway editor does the parse (the markdown manager parses via setContent), so the
 * result matches the live editor's schema exactly. Returns [] if parsing yields nothing.
 */
export function parseMarkdownToContent(markdown: string): JSONContent[] {
  const tmp = new Editor({ extensions: notebookExtensions() });
  try {
    tmp.commands.setContent(markdown, { contentType: 'markdown' } as never);
    return (tmp.getJSON().content ?? []) as JSONContent[];
  } finally {
    tmp.destroy();
  }
}

/**
 * Replace an aiBlock's content with PARSED Markdown — the finished-answer path. While
 * streaming we show literal text (fast, live); on done we parse the answer so a generated
 * list/heading/code block renders as real nodes and round-trips to Markdown correctly
 * (review finding #4: literal text was being saved as escaped prose). Falls back to literal
 * text if the parse fails or yields nothing, so a malformed answer never blanks the block.
 * No-op (false) if the block was deleted mid-stream. This change DOES go into undo history.
 */
export function setAiBlockMarkdown(editor: Editor, blockId: string, markdown: string): boolean {
  const hit = findAiBlock(editor, blockId);
  if (!hit) return false;
  const { state, view } = editor;
  const fragmentStart = hit.pos + 1;
  const fragmentEnd = hit.pos + hit.nodeSize - 1;
  try {
    const json = parseMarkdownToContent(markdown);
    const source = json.length ? json : [{ type: 'paragraph' }];
    const nodes = source.map((j) => state.schema.nodeFromJSON(j));
    view.dispatch(state.tr.replaceWith(fragmentStart, fragmentEnd, nodes));
    return true;
  } catch {
    // Schema mismatch / bad JSON — never lose the answer; fall back to literal text.
    return setAiBlockText(editor, blockId, markdown);
  }
}

/**
 * Collect the AI blocks currently in the doc as sidecar metadata (blockId + prompt/model +
 * re-run inputs), in document order. This is the SAVE side of AI-block persistence: the live
 * doc is authoritative for which blocks exist, so the sidecar is rewritten from exactly these.
 * Blocks without a real blockId are skipped (they can't be keyed to an anchor). `createdAt` is
 * left for the store to fill/preserve, so it stays stable across saves.
 */
export function collectAiBlocks(editor: Editor): Array<Omit<AIBlockMeta, 'createdAt'>> {
  const blocks: Array<Omit<AIBlockMeta, 'createdAt'>> = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name !== 'aiBlock') return true;
    const a = node.attrs as { blockId?: string | null; prompt?: string | null; model?: string | null; commandId?: string | null; selection?: string | null };
    if (typeof a.blockId === 'string' && a.blockId.length) {
      blocks.push({
        blockId: a.blockId,
        prompt: a.prompt ?? '',
        model: a.model ?? '',
        commandId: a.commandId ?? undefined,
        selection: a.selection ?? undefined,
      });
    }
    return false; // aiBlocks don't nest — no need to descend into their content
  });
  return blocks;
}

/** Patch an aiBlock's transient attrs (e.g. state: 'generating' | 'error' | 'done'). */
export function setAiBlockAttrs(editor: Editor, blockId: string, attrs: Record<string, unknown>): boolean {
  const hit = findAiBlock(editor, blockId);
  if (!hit) return false;
  const { state, view } = editor;
  const tr = state.tr.setNodeMarkup(hit.pos, undefined, { ...hit.attrs, ...attrs });
  tr.setMeta('addToHistory', false);
  view.dispatch(tr);
  return true;
}
