// Google-Docs-style Tab indent for plain blocks. Lists already nest on Tab via StarterKit's
// listItemKeymap, so here Tab/Shift-Tab: (1) delegate to list sink/lift when inside a list,
// otherwise (2) bump an `indent` level on the paragraph/heading. The level renders as a
// left margin and round-trips through Markdown as an HTML `style` on the block (see
// extensions.ts — paragraph/heading get renderMarkdown that emits the margin when indented).

import { Extension } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';

export const MAX_INDENT = 10;
export const INDENT_EM = 2.5; // margin-left per level

export const CODE_INDENT = '  '; // one code-block indent step (2 spaces)

// Leading whitespace of the line ending at `offset` in `text` — used for code-block auto-indent.
export const leadingWhitespace = (text: string, offset: number): string => {
  const upto = text.slice(0, offset);
  return (upto.slice(upto.lastIndexOf('\n') + 1).match(/^[ \t]*/) ?? [''])[0];
};

// IDE-style newline in a code block. Given the block text + cursor offset, return the string to
// insert and how many chars to walk the caret back afterward (for electric brace expansion).
// - after an opener ({ ( [) at line end → indent the new line one step deeper
// - cursor sitting between a matching pair ({|}) → expand to 3 lines, caret on the middle one
// - otherwise → carry the current line's indent (plain auto-indent)
export function codeBlockEnter(text: string, offset: number, unit = CODE_INDENT): { insert: string; caretBack: number } {
  const base = leadingWhitespace(text, offset);
  const lineBefore = text.slice(0, offset).split('\n').pop() ?? '';
  const opensBlock = /[{([]\s*$/.test(lineBefore);
  const next = text[offset];
  const closesPair = opensBlock && (next === '}' || next === ')' || next === ']');
  if (closesPair) return { insert: `\n${base}${unit}\n${base}`, caretBack: base.length + 1 };
  return { insert: `\n${opensBlock ? base + unit : base}`, caretBack: 0 };
}

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
    // Inside a code block, Tab/Enter behave like an IDE (soft 2-space indent, auto-indent on
    // newline) instead of the block-level Google-Docs indent used everywhere else.
    const INDENT_UNIT = CODE_INDENT;
    const inCode = () => this.editor.isActive('codeBlock');
    const typeText = (text: string) =>
      this.editor.chain().focus().command(({ tr, dispatch }) => {
        if (dispatch) dispatch(tr.insertText(text));
        return true;
      }).run();
    // Return true in every branch so focus never tab-escapes the editor (even at max/min indent).
    return {
      Tab: () => {
        if (inCode()) { typeText(INDENT_UNIT); return true; }
        if (this.editor.can().sinkListItem('listItem')) {
          this.editor.chain().focus().sinkListItem('listItem').run();
        } else {
          this.editor.commands.indent();
        }
        return true;
      },
      'Shift-Tab': () => {
        if (inCode()) {
          // Remove up to one indent unit of whitespace immediately before the cursor.
          const { state } = this.editor;
          const to = state.selection.from;
          const before = state.doc.textBetween(Math.max(0, to - INDENT_UNIT.length), to);
          const del = before.endsWith(INDENT_UNIT) ? INDENT_UNIT.length : before.endsWith(' ') || before.endsWith('\t') ? 1 : 0;
          if (del) this.editor.chain().focus().deleteRange({ from: to - del, to }).run();
          return true;
        }
        if (this.editor.can().liftListItem('listItem')) {
          this.editor.chain().focus().liftListItem('listItem').run();
        } else {
          this.editor.commands.outdent();
        }
        return true;
      },
      Enter: () => {
        // IDE-style auto-indent: deeper after an opener, electric expansion inside a pair.
        if (inCode()) {
          const { $from } = this.editor.state.selection;
          const { insert, caretBack } = codeBlockEnter($from.parent.textContent, $from.parentOffset, INDENT_UNIT);
          typeText(insert);
          if (caretBack) this.editor.commands.setTextSelection(this.editor.state.selection.from - caretBack);
          return true;
        }
        return false; // non-code Enter: let list/paragraph defaults handle it
      },
    };
  },
});
