// The TipTap extension set for the notebook editor. Shared by the React editor component,
// the headless serializer tests, AND the load-time reconstructor (reconstruct.ts) so on-disk
// Markdown fidelity is verified against — and reloaded through — the EXACT schema the user
// edits in. If these drift, formatting (color/highlight/code) survives editing but is dropped
// on reload; keeping one factory is what prevents that.

import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import type { AnyExtension } from '@tiptap/core';
import { TextStyle, Color, FontFamily, FontSize } from '@tiptap/extension-text-style';
import { Highlight } from '@tiptap/extension-highlight';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { createLowlight, common } from 'lowlight';
import java from 'highlight.js/lib/languages/java';
import { Paragraph } from '@tiptap/extension-paragraph';
import { Heading } from '@tiptap/extension-heading';
import { Indent, INDENT_EM } from './indent';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { AiBlock } from './ai-block';
import { Drawing } from './drawing';

// Syntax highlighting for code blocks — `common` bundles ~37 languages (java, js, python, …).
// Exported so the live editor can build a NodeView variant that reuses this same instance.
export const lowlight = createLowlight(common);
// highlight.js's Java grammar leaves dotted method calls (System.out.println, list.add) unstyled,
// so println/print/etc. render as plain text unlike a real IDE. Re-register java with a leading
// rule that tags `.method(` invocations as title.function_ (picks up the .hljs-title color).
// ponytail: dotted calls only — bare `foo()` and the receiver (System/out) stay plain, which
// avoids mis-coloring keywords like `if (`/`for (`.
lowlight.register('java', (hljs: Parameters<typeof java>[0]) => {
  const def = java(hljs);
  // multi-match begin + scoped className (className:{2:...}) is valid highlight.js but missing
  // from lowlight's Mode typings, hence the cast.
  def.contains.unshift({
    begin: [/\./, hljs.UNDERSCORE_IDENT_RE, /(?=\s*\()/],
    className: { 2: 'title.function_' },
    relevance: 0,
  } as never);
  return def;
});

// Markdown has no syntax for text color / highlight, so we serialize those marks to inline
// HTML (`<span style="color">`, `<mark style="background-color">`) — which the marks'
// parseHTML rebuilds on load, so color + highlight survive the on-disk Markdown round-trip.
// Only emit a color we can prove is a plain CSS color. The Color mark's parseHTML
// CSS-normalizes + strips quotes, but Highlight's parseHTML reads `data-color` RAW —
// so untrusted on-disk Markdown (model/clipboard output) could round-trip an unescaped value
// into `node.attrs.color`. Allowlisting hex / rgb() / hsl() / a bare name keeps the
// serialized `<span>`/`<mark>` HTML injection-free even on export.
const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$|^rgba?\([\d.,\s%/]+\)$|^hsla?\([\d.,\s%/]+\)$|^[a-zA-Z]{1,32}$/;
// font-family (e.g. "Times New Roman") and font-size (e.g. "16px") also round-trip through the
// same `<span style>`, so allowlist their values too — no `<>"'();` that could break out of the
// style attribute or inject extra CSS when untrusted on-disk markdown is reparsed/exported.
const SAFE_FAMILY = /^[a-zA-Z0-9 ,\-]{1,64}$/;
const SAFE_SIZE = /^\d{1,3}(\.\d+)?(px|pt|em|rem)$/;
const attr = (node: unknown, key: 'color' | 'fontFamily' | 'fontSize'): string | undefined =>
  (node as { attrs?: Record<string, string> })?.attrs?.[key]?.trim() || undefined;
const markColor = (node: unknown): string | undefined => {
  const c = attr(node, 'color');
  return c && SAFE_COLOR.test(c) ? c : undefined;
};
const markStyle = (node: unknown): string => {
  const parts: string[] = [];
  const color = attr(node, 'color'); if (color && SAFE_COLOR.test(color)) parts.push(`color: ${color}`);
  const family = attr(node, 'fontFamily'); if (family && SAFE_FAMILY.test(family)) parts.push(`font-family: ${family}`);
  const size = attr(node, 'fontSize'); if (size && SAFE_SIZE.test(size)) parts.push(`font-size: ${size}`);
  return parts.join('; ');
};

export const TextStyleMd = TextStyle.extend({
  renderMarkdown(node: unknown, { renderChildren }: { renderChildren: () => string }) {
    const style = markStyle(node);
    const inner = renderChildren();
    return style ? `<span style="${style}">${inner}</span>` : inner;
  },
} as never);

// Tab-indent (see indent.ts) is a block `indent` level with no Markdown syntax, so an indented
// paragraph/heading serializes as an HTML block carrying the left margin. renderChildren() emits
// the inner Markdown, which GFM re-parses inside the block tag (bold/links survive — verified in
// serializer.test.ts). Unindented blocks fall through to the default (plain paragraph / `#`).
const indentAttr = (node: unknown): number => (node as { attrs?: { indent?: number } })?.attrs?.indent || 0;
type NodeArg = { attrs?: { indent?: number; level?: number }; content?: unknown[] };
// Pass the content array (never the node itself): the markdown lib treats a node with no
// `content` as an array and re-enters this handler → infinite recursion on an empty paragraph.
const kids = (node: NodeArg, render: (n: unknown[]) => string): string => render(node.content ?? []);
export const ParagraphMd = Paragraph.extend({
  renderMarkdown(node: NodeArg, { renderChildren }: { renderChildren: (n: unknown[]) => string }) {
    const n = indentAttr(node);
    const inner = kids(node, renderChildren);
    return n > 0 ? `<p style="margin-left: ${n * INDENT_EM}em">\n\n${inner}\n\n</p>` : inner;
  },
} as never);
export const HeadingMd = Heading.extend({
  renderMarkdown(node: NodeArg, { renderChildren }: { renderChildren: (n: unknown[]) => string }) {
    const level = node?.attrs?.level || 1;
    const inner = kids(node, renderChildren);
    const n = indentAttr(node);
    return n > 0
      ? `<h${level} style="margin-left: ${n * INDENT_EM}em">\n\n${inner}\n\n</h${level}>`
      : `${'#'.repeat(level)} ${inner}`;
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
export function notebookExtensions(opts?: { aiBlock?: AnyExtension; codeBlock?: AnyExtension; drawing?: AnyExtension }): AnyExtension[] {
  return [
    // paragraph/heading swapped for indent-aware variants (Markdown-serialize their indent level).
    StarterKit.configure({ codeBlock: false, paragraph: false, heading: false, link: { openOnClick: false } }),
    ParagraphMd,
    HeadingMd,
    Indent,
    Markdown,
    opts?.aiBlock ?? AiBlock,
    // Live editor passes a React-NodeView variant (PNG preview + open-canvas); headless paths
    // use the plain node so markdown round-tripping needs no React.
    opts?.drawing ?? Drawing,
    TextStyleMd,
    Color,
    // Per-selection font + size, stored as `textStyle` mark attrs → they live in the document,
    // so undo/redo captures them and they serialize into the `<span style>` above.
    FontFamily,
    FontSize,
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
