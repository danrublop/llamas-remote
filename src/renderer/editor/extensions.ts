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
import { AiBlock } from './ai-block';

// Syntax highlighting for code blocks — `common` bundles ~37 languages (java, js, python, …).
const lowlight = createLowlight(common);

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
export function notebookExtensions(opts?: { aiBlock?: AnyExtension }): AnyExtension[] {
  return [
    StarterKit.configure({ codeBlock: false, link: { openOnClick: false } }),
    Markdown,
    opts?.aiBlock ?? AiBlock,
    TextStyleMd,
    Color,
    HighlightMd.configure({ multicolor: true }),
    CodeBlockLowlight.configure({ lowlight }),
  ];
}
