// The TipTap extension set for the notebook editor. Shared by the React editor component,
// the headless serializer tests, AND the load-time reconstructor (reconstruct.ts) so on-disk
// Markdown fidelity is verified against — and reloaded through — the EXACT schema the user
// edits in. If these drift, formatting (color/highlight/code) survives editing but is dropped
// on reload; keeping one factory is what prevents that.

import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import type { AnyExtension } from '@tiptap/core';
import { TextStyle, Color } from '@tiptap/extension-text-style';
import { Highlight } from '@tiptap/extension-highlight';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { createLowlight, common } from 'lowlight';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { AiBlock } from './ai-block';

// Syntax highlighting for code blocks — `common` bundles ~37 languages (java, js, python, …).
// Exported so the live editor can build a NodeView variant that reuses this same instance.
export const lowlight = createLowlight(common);

// Markdown has no syntax for text color / highlight, so we serialize those marks to inline
// HTML (`<span style="color">`, `<mark style="background-color">`) — which the marks'
// parseHTML rebuilds on load, so color + highlight survive the on-disk Markdown round-trip.
// Only emit a color we can prove is a plain CSS color. The Color mark's parseHTML
// CSS-normalizes + strips quotes, but Highlight's parseHTML reads `data-color` RAW —
// so untrusted on-disk Markdown (model/clipboard output) could round-trip an unescaped value
// into `node.attrs.color`. Allowlisting hex / rgb() / hsl() / a bare name keeps the
// serialized `<span>`/`<mark>` HTML injection-free even on export.
const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$|^rgba?\([\d.,\s%/]+\)$|^hsla?\([\d.,\s%/]+\)$|^[a-zA-Z]{1,32}$/;
const markColor = (node: unknown): string | undefined => {
  const c = (node as { attrs?: { color?: string } })?.attrs?.color?.trim();
  return c && SAFE_COLOR.test(c) ? c : undefined;
};

export const TextStyleMd = TextStyle.extend({
  renderMarkdown(node: unknown, { renderChildren }: { renderChildren: () => string }) {
    const color = markColor(node);
    const inner = renderChildren();
    return color ? `<span style="color: ${color}">${inner}</span>` : inner;
  },
} as never);

export const HighlightMd = Highlight.extend({
  renderMarkdown(node: unknown, { renderChildren }: { renderChildren: () => string }) {
    const color = markColor(node);
    const inner = renderChildren();
    return color ? `<mark style="background-color: ${color}">${inner}</mark>` : `<mark>${inner}</mark>`;
  },
} as never);

// @tiptap/markdown's built-in table serializer does NOT escape `|` inside cell content, so a
// cell like `grep x | wc` silently loses everything after the pipe on the next save/reload
// (the GFM parser reads the extra pipe as a column break and drops the overflow). We own the
// whole table serialization here instead: one GFM row per table row, `\|` for literal pipes,
// newlines collapsed to spaces (GFM cells are single-line). A Table-node renderMarkdown
// REPLACES the built-in table handling (verified), so this is the single source of truth.
// renderMarkdown receives a JSON node ({ type, attrs, content: [...] }), and renderChildren(n)
// renders n.content — so we walk node.content (rows) → row.content (cells).
type JsonNode = { type?: string; content?: JsonNode[] };
const renderCell = (cell: JsonNode, renderChildren: (n: JsonNode) => string): string =>
  (renderChildren(cell).trim().replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|')) || ' ';
export const TableMd = Table.extend({
  renderMarkdown(node: JsonNode, { renderChildren }: { renderChildren: (n: JsonNode) => string }) {
    const rows: string[][] = [];
    for (const row of node.content ?? []) {
      rows.push((row.content ?? []).map((cell) => renderCell(cell, renderChildren)));
    }
    if (rows.length === 0) return '';
    const cols = Math.max(...rows.map((r) => r.length));
    const pad = (r: string[]) => { const c = [...r]; while (c.length < cols) c.push(' '); return c; };
    const line = (r: string[]) => `| ${pad(r).join(' | ')} |`;
    const sep = `| ${Array(cols).fill('---').join(' | ')} |`;
    const [head, ...body] = rows;
    return [line(head), sep, ...body.map(line)].join('\n');
  },
} as never).configure({ resizable: true });

/**
 * Extensions for the notebook editor: rich text (StarterKit), Markdown serialization, the
 * custom AI block, text color / highlight, and syntax-highlighted code blocks.
 *
 * Note bodies contain model- and clipboard-sourced content, so links in them are untrusted.
 * StarterKit bundles Link with `openOnClick: true`, which calls `window.open()` from the
 * renderer on click; we disable that here (external links route through the main process's
 * window-open handler → `shell.openExternal`).
 *
 * `opts.aiBlock` lets the live editor pass the React-NodeView variant of the AI block while
 * the headless parse/serialize paths use the plain node — same schema, so JSON is compatible.
 */
export function notebookExtensions(opts?: { aiBlock?: AnyExtension; codeBlock?: AnyExtension }): AnyExtension[] {
  return [
    StarterKit.configure({ codeBlock: false, link: { openOnClick: false } }),
    Markdown,
    opts?.aiBlock ?? AiBlock,
    TextStyleMd,
    Color,
    HighlightMd.configure({ multicolor: true }),
    // Live editor passes a NodeView variant (in-block language dropdown); headless paths use
    // the plain node so markdown round-tripping is unchanged.
    opts?.codeBlock ?? CodeBlockLowlight.configure({ lowlight }),
    TableMd,
    TableRow,
    TableHeader,
    TableCell,
  ];
}
