// Inline code (the `code` mark) is only ever a single token — a word, a function name, etc.
// So make it easy to leave: pressing Enter or typing a second consecutive space turns the mark
// off, and the exit space(s) are never themselves code-styled.
// ponytail: assumes inline code holds no internal spaces (word/function only). If multi-word
// code spans become a thing, gate the double-space rule on being at the span's end instead.

import { Extension } from '@tiptap/core';

export const InlineCodeExit = Extension.create({
  name: 'inlineCodeExit',
  // Run before StarterKit's Enter (splitBlock) and Indent so we can intercept while in code.
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      // New line: split the block as Enter normally would, then drop the code mark so the new
      // line is plain text.
      Enter: () => {
        if (!this.editor.isActive('code')) return false;
        return this.editor.chain().splitBlock().unsetMark('code').run();
      },
      // Double-space exits. We insert BOTH spaces ourselves (returning true → preventDefault) so
      // the native editing layer never sees two consecutive typed spaces — otherwise macOS's
      // "Add period with double-space" substitution turns them into ". " before we can react.
      // First space: type it (still code). Second space: drop that space, emit one plain space,
      // mark off — so the trailing space isn't code-styled and there's no double space.
      Space: () => {
        const { editor } = this;
        if (!editor.isActive('code')) return false;
        const { from, empty } = editor.state.selection;
        if (!empty || from < 1) return false;
        if (editor.state.doc.textBetween(from - 1, from) === ' ') {
          return editor.chain()
            .deleteRange({ from: from - 1, to: from })
            .unsetMark('code')
            .insertContent(' ')
            .run();
        }
        return editor.chain().insertContent(' ').run(); // first space, inserted by us not the OS
      },
    };
  },
});
