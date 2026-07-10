// Two live editor plugins registered from the notebook toolbar layer (not part of the shared
// schema, so headless parse/serialize is untouched):
//   • searchPlugin  — ⌘F find-in-note: inline-highlights every match, marks the current one.
//   • headingFlagPlugin — a sparkle "flag" in the left gutter of every heading; two-finger-click
//     it to colour that section. Colour is keyed by heading text (see notebook.tsx), so it needs
//     no schema/markdown change. ponytail: text-keyed → duplicate-named headings share a flag and
//     renaming a heading drops it; fine for a personal notebook, revisit with a node id if needed.
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

// Lucide "sparkles".
export const SPARKLE_SVG =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>';

// ---- in-note find --------------------------------------------------------------------------
export const searchKey = new PluginKey('inNoteSearch');
export type Range = { from: number; to: number };
export type SearchState = { query: string; current: number; ranges: Range[] };

function findRanges(doc: PMNode, query: string): Range[] {
  const ranges: Range[] = [];
  if (!query) return ranges;
  const q = query.toLowerCase();
  // ponytail: matches within a single text node — a query spanning a mark boundary (half bold)
  // won't match. Covers normal word/phrase search; widen only if it bites.
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const t = node.text.toLowerCase();
    let i = t.indexOf(q);
    while (i !== -1) { ranges.push({ from: pos + i, to: pos + i + q.length }); i = t.indexOf(q, i + q.length); }
  });
  return ranges;
}

export function searchPlugin() {
  return new Plugin<SearchState>({
    key: searchKey,
    state: {
      init: () => ({ query: '', current: 0, ranges: [] }),
      apply(tr, val) {
        const meta = tr.getMeta(searchKey) as Partial<SearchState> | undefined;
        let query = val.query;
        let current = val.current;
        if (meta) {
          if (meta.query !== undefined) query = meta.query;
          if (meta.current !== undefined) current = meta.current;
        }
        const ranges = meta || tr.docChanged ? findRanges(tr.doc, query) : val.ranges;
        if (current >= ranges.length) current = 0;
        return { query, current, ranges };
      },
    },
    props: {
      decorations(state) {
        const s = searchKey.getState(state) as SearchState;
        if (!s.ranges.length) return DecorationSet.empty;
        return DecorationSet.create(state.doc, s.ranges.map((r, i) =>
          Decoration.inline(r.from, r.to, { class: i === s.current ? 'search-hl search-hl-cur' : 'search-hl' })));
      },
    },
  });
}

// ---- heading gutter flags ------------------------------------------------------------------
export const flagKey = new PluginKey('headingFlags');

export function headingFlagPlugin(
  getColor: (headingText: string) => string | undefined,
  onPick: (headingText: string, x: number, y: number) => void,
) {
  const build = (doc: PMNode) => {
    const decos: Decoration[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name !== 'heading') return;
      const text = node.textContent.trim();
      const color = getColor(text);
      decos.push(Decoration.widget(pos + 1, () => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.contentEditable = 'false';
        btn.className = color ? 'head-flag on' : 'head-flag';
        btn.title = 'Flag section (right-click to colour)';
        btn.innerHTML = SPARKLE_SVG;
        if (color) btn.style.color = color;
        btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret put
        const open = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); onPick(text, e.clientX, e.clientY); };
        btn.addEventListener('click', open);
        btn.addEventListener('contextmenu', open);
        return btn;
      }, { side: -1, key: `flag-${text}-${color || ''}` }));
    });
    return DecorationSet.create(doc, decos);
  };
  return new Plugin({
    key: flagKey,
    state: {
      init: (_c, { doc }) => build(doc),
      apply(tr, old: DecorationSet) {
        if (tr.docChanged || tr.getMeta(flagKey)) return build(tr.doc);
        return old.map(tr.mapping, tr.doc);
      },
    },
    props: { decorations(state) { return flagKey.getState(state) as DecorationSet; } },
  });
}
