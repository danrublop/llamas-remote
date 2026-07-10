// Google-Docs-style Tab indent for plain blocks. Lists already nest on Tab via StarterKit's
// listItemKeymap, so here Tab/Shift-Tab: (1) delegate to list sink/lift when inside a list,
// otherwise (2) bump an `indent` level on the paragraph/heading. The level renders as a
// left margin and round-trips through Markdown as an HTML `style` on the block (see
// extensions.ts — paragraph/heading get renderMarkdown that emits the margin when indented).

import { Extension } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';

export const MAX_INDENT = 10;
export const INDENT_EM = 2.5; // margin-left per level

const INDENTABLE = ['paragraph', 'heading'];

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    indent: {
      indent: () => ReturnType;
      outdent: () => ReturnType;
    };
  }
}

export const Indent = Extension.create({
  name: 'indent',

  addGlobalAttributes() {
    return [{
      types: INDENTABLE,
      attributes: {
        indent: {
          default: 0,
          // Only carried in the DOM/markdown when non-zero; parsed back from the left margin.
          renderHTML: (attrs) =>
            attrs.indent ? { style: `margin-left: ${attrs.indent * INDENT_EM}em` } : {},
          parseHTML: (el) => {
            const ml = parseFloat((el as HTMLElement).style.marginLeft || '0');
            return ml > 0 ? Math.min(MAX_INDENT, Math.max(1, Math.round(ml / INDENT_EM))) : 0;
          },
        },
      },
    }];
  },

  addCommands() {
    const shift = (delta: number) =>
      ({ state, tr, dispatch }: { state: EditorState; tr: Transaction; dispatch?: (tr: Transaction) => void }) => {
        const { from, to } = state.selection;
        let changed = false;
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!INDENTABLE.includes(node.type.name)) return;
          const cur: number = node.attrs.indent || 0;
          const next = Math.max(0, Math.min(MAX_INDENT, cur + delta));
          if (next !== cur) {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
            changed = true;
          }
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      };
    return {
      indent: () => shift(1),
      outdent: () => shift(-1),
    };
  },

  addKeyboardShortcuts() {
    // Return true in every branch so focus never tab-escapes the editor (even at max/min indent).
    return {
      Tab: () => {
        if (this.editor.can().sinkListItem('listItem')) {
          this.editor.chain().focus().sinkListItem('listItem').run();
        } else {
          this.editor.commands.indent();
        }
        return true;
      },
      'Shift-Tab': () => {
        if (this.editor.can().liftListItem('listItem')) {
          this.editor.chain().focus().liftListItem('listItem').run();
        } else {
          this.editor.commands.outdent();
        }
        return true;
      },
    };
  },
});
