// CalendarEvent: a structured "event container" block for the day pages. It's an opaque leaf
// (attrs: title/time/color) rendered by event-view as a colored box; the user types freely in
// paragraphs above and below it. It round-trips as a self-contained HTML block in the day's
// Markdown, so the day file stays plain Markdown and the box rebuilds via parseHTML on load.
//
//   node(attrs) ──renderMarkdown──▶  <div data-cal-event data-title="…" data-time="…" data-color="#…"></div>
//                    parseHTML  ◀──  (same div)
//
// title/time are untrusted (typed, could hold quotes/angle brackets) so renderMarkdown escapes
// them, and color is allowlisted to a hex value — the serialized HTML can't break its attributes
// or inject markup even when a day file is edited by hand or exported.

import { Node, mergeAttributes } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attrStr = (el: Element, name: string) => (el as HTMLElement).getAttribute(name) || '';

/** The canonical serialized form of an event. Exported because the calendar's week grid rewrites
 *  these divs in place when you drag/resize an event, and must escape exactly the same way. */
export function eventHtml(a: { title?: string; start?: string; end?: string; color?: string }): string {
  const color = a.color && SAFE_COLOR.test(a.color) ? a.color : '#3b82f6';
  return `<div data-cal-event data-title="${esc(a.title || '')}" data-start="${esc(a.start || '')}" data-end="${esc(a.end || '')}" data-color="${color}"></div>`;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    calendarEvent: { insertCalendarEvent: (attrs?: { title?: string; start?: string; end?: string; color?: string }) => ReturnType };
  }
}

export const CalendarEvent = Node.create({
  name: 'calendarEvent',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      title: { default: '', parseHTML: (el) => attrStr(el, 'data-title'), renderHTML: (a) => ({ 'data-title': a.title || '' }) },
      // start/end are HH:MM (24h, as native <input type=time> gives). `data-time` is the old
      // single-time attr — read it as the start so pre-existing events keep their time on load.
      start: { default: '', parseHTML: (el) => attrStr(el, 'data-start') || attrStr(el, 'data-time'), renderHTML: (a) => ({ 'data-start': a.start || '' }) },
      end: { default: '', parseHTML: (el) => attrStr(el, 'data-end'), renderHTML: (a) => ({ 'data-end': a.end || '' }) },
      color: {
        default: '#3b82f6',
        parseHTML: (el) => { const c = attrStr(el, 'data-color'); return SAFE_COLOR.test(c) ? c : '#3b82f6'; },
        renderHTML: (a) => ({ 'data-color': SAFE_COLOR.test(a.color) ? a.color : '#3b82f6' }),
      },
    };
  },

  addCommands() {
    return {
      insertCalendarEvent: (attrs = {}) => ({ commands }) =>
        commands.insertContent({ type: this.name, attrs: { title: '', start: '', end: '', color: '#3b82f6', ...attrs } }),
    };
  },

  // ProseMirror marks a node with .ProseMirror-selectednode only when it IS the selection. Drag a
  // highlight across text and events (what Repeat acts on) and the events inside it get no marker at
  // all — so you can't see what you're about to repeat. Decorate any event within the range instead.
  addProseMirrorPlugins() {
    const name = this.name;
    return [
      new Plugin({
        props: {
          decorations(state) {
            const { from, to, empty } = state.selection;
            if (empty) return null;
            const found: Decoration[] = [];
            state.doc.nodesBetween(from, to, (node, pos) => {
              if (node.type.name === name) found.push(Decoration.node(pos, pos + node.nodeSize, { class: 'ev-in-selection' }));
            });
            return found.length ? DecorationSet.create(state.doc, found) : null;
          },
        },
      }),
    ];
  },

  parseHTML() {
    return [{ tag: 'div[data-cal-event]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-cal-event': '' })];
  },

  renderMarkdown(node: { attrs?: { title?: string; start?: string; end?: string; color?: string } }) {
    return eventHtml(node.attrs || {});
  },
} as Parameters<typeof Node.create>[0]);
