// Drawing: a TipTap node wrapping an Excalidraw sketch inside a note.
//
// In the editor it renders (via drawing-view) as a PNG preview the user can double-click to
// re-open the full Excalidraw canvas. On disk the note's Markdown must stay human-readable and
// viewable anywhere, so it serializes to an invisible anchor comment `<!--draw:<id>-->` above a
// standard Markdown image pointing at the flattened PNG the store writes into images/:
//
//   editor node  ──renderMarkdown──▶  <!--draw:01ABC-->
//   (attrs: drawingId, scene)          ![drawing](images/draw-01ABC.png)
//                                       ▲ the re-editable scene JSON lives in the
//                                         <id>.draw.json sidecar, keyed by drawingId
//
// Markdown → Drawing is reconstructed at load time by scanning the anchor and pairing it with
// the sidecar scene (reconstruct.ts) — an HTML comment carries no content boundary a Markdown
// parser preserves, exactly as with the AI block. If the anchor is lost (external edit), the
// `![drawing](…png)` image simply renders as an ordinary image reference — graceful degradation.
//
// The `scene` attr is held in the live doc (rendered:false) so undo/redo and in-session edits
// are self-contained; it is persisted to the sidecar on save and rebuilt from it on load. It is
// NEVER serialized into the Markdown.

import { Node, mergeAttributes } from '@tiptap/core';

export const Drawing = Node.create({
  name: 'drawing',
  group: 'block',
  atom: true,       // opaque leaf — no editable inner content
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      drawingId: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-drawing-id'),
        renderHTML: (attrs) => (attrs.drawingId ? { 'data-drawing-id': attrs.drawingId } : {}),
      },
      // The Excalidraw scene ({ elements, files, ... }). Lives in the doc but never rendered to
      // HTML or Markdown — it round-trips through the sidecar (see reconstruct.ts / drawing-sidecar).
      scene: { default: null, rendered: false },
      // Transient flattened-PNG data-URL, set when the user edits the drawing this session:
      // shown as the instant preview and passed to the store to (re)write images/draw-<id>.png.
      // Never persisted to Markdown or the sidecar; null after a reload (the NodeView then reads
      // the on-disk PNG via IPC).
      png: { default: null, rendered: false },
    };
  },

  // The React editor sets onEdit here after construction; the NodeView calls it to open the
  // Excalidraw modal. Kept in storage (not options) so the headless serializer needs no React.
  addStorage() {
    return { onEdit: null as ((drawingId: string) => void) | null };
  },

  parseHTML() {
    return [{ tag: 'div[data-drawing]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-drawing': '' })];
  },

  // Invisible anchor (carries the id that keys the sidecar) + a standard Markdown image so the
  // raw .md is viewable in any Markdown reader. Reconstruction (markdown -> drawing) is done
  // from the raw text by markdownToDoc (reconstruct.ts), since the parser strips the comment.
  renderMarkdown(node: { attrs?: { drawingId?: string | null } }) {
    const id = node.attrs?.drawingId ?? '';
    return `<!--draw:${id}-->\n![drawing](images/draw-${id}.png)`;
  },
} as Parameters<typeof Node.create>[0]);
