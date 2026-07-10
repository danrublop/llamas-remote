// Reconstruct a TipTap doc from saved Markdown + sidecar metadata.
//
// The Markdown parser strips HTML comments, so AI-block anchors don't survive a plain
// markdown->doc parse (verified empirically). Instead we split the RAW Markdown on the
// AI-block comment pair `<!--ai:id-->...<!--/ai-->`, parse each segment, and wrap the AI
// segments in aiBlock nodes enriched from the sidecar (model/prompt by blockId).
//
//   raw .md ──split on <!--ai:id-->…<!--/ai-->──┬─ plain segment ─▶ parse ─▶ nodes
//                                               └─ ai segment ────▶ parse ─▶ wrap aiBlock(meta)
//                                                                   └▶ concat ─▶ doc
//
// Degradation: if the markers were lost (external edit), there's no ai segment to wrap and
// the text simply renders as plain prose — matching the sidecar reconcile rule.

import { Editor } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { notebookExtensions } from './extensions';
import type { AIBlockMeta } from '../../main/services/notebook/sidecar';
import type { DrawingMeta } from '../../main/services/notebook/drawing-sidecar';

// One tokenizer over BOTH block markers so they're split in document order: an AI-block
// comment PAIR (id + inner md, groups 1–2) or a Drawing anchor + its viewable image line
// (id, group 3). The drawing image line is consumed here so it never reaches the parser (the
// node is rebuilt from the sidecar scene instead).
const AI_PAIR_SRC = '<!--ai:([a-zA-Z0-9_-]*)-->\\n?([\\s\\S]*?)\\n?<!--\\/ai-->';
const DRAW_SRC = '<!--draw:([a-zA-Z0-9_-]*)-->(?:\\n!\\[[^\\]]*\\]\\([^)]*\\))?';
const MARKERS = new RegExp(`${AI_PAIR_SRC}|${DRAW_SRC}`, 'g');

interface Segment {
  ai: boolean;
  draw?: boolean;
  blockId?: string;
  drawingId?: string;
  md: string;
}

/** Split raw Markdown into ordered plain / ai / drawing segments by the marker comments. */
export function splitSegments(markdown: string): Segment[] {
  const segs: Segment[] = [];
  let last = 0;
  for (const m of markdown.matchAll(MARKERS)) {
    const start = m.index ?? 0;
    if (start > last) segs.push({ ai: false, md: markdown.slice(last, start) });
    if (m[1] !== undefined) segs.push({ ai: true, blockId: m[1], md: m[2] });      // AI-block pair
    else segs.push({ ai: false, draw: true, drawingId: m[3], md: '' });            // drawing anchor
    last = start + m[0].length;
  }
  if (last < markdown.length) segs.push({ ai: false, md: markdown.slice(last) });
  return segs;
}

/**
 * Build a TipTap doc (JSON) from saved Markdown + the note's sidecar metadata. AI segments
 * become aiBlock nodes carrying their blockId and (from the sidecar) model + prompt.
 */
export function markdownToDoc(markdown: string, meta: readonly AIBlockMeta[] = [], drawings: readonly DrawingMeta[] = []): JSONContent {
  const byId = new Map(meta.map((m) => [m.blockId, m]));
  const sceneById = new Map(drawings.map((d) => [d.drawingId, d.scene]));
  const editor = new Editor({ extensions: notebookExtensions() });
  const parse = (md: string): JSONContent[] => {
    editor.commands.setContent(md, { contentType: 'markdown' } as never);
    return (editor.getJSON().content ?? []) as JSONContent[];
  };

  try {
    const content: JSONContent[] = [];
    for (const seg of splitSegments(markdown)) {
      if (seg.draw) {
        content.push({
          type: 'drawing',
          attrs: { drawingId: seg.drawingId ?? null, scene: (seg.drawingId ? sceneById.get(seg.drawingId) : null) ?? null },
        });
        continue;
      }
      const inner = parse(seg.md).filter((n) => !(n.type === 'paragraph' && !n.content)); // drop empty separators
      if (seg.ai) {
        const m = seg.blockId ? byId.get(seg.blockId) : undefined;
        content.push({
          type: 'aiBlock',
          attrs: {
            blockId: seg.blockId ?? null,
            model: m?.model ?? null,
            prompt: m?.prompt ?? null,
            // Re-run inputs from the sidecar so a reloaded block re-runs its original command.
            commandId: m?.commandId ?? null,
            selection: m?.selection ?? null,
            state: 'done',
          },
          content: inner.length ? inner : [{ type: 'paragraph' }],
        });
      } else {
        content.push(...inner);
      }
    }
    return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
  } finally {
    editor.destroy();
  }
}
