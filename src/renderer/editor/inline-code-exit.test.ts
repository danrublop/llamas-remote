// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { notebookExtensions } from './extensions';

function codeEditor(): Editor {
  // A paragraph with the cursor inside an inline-code span ("foo").
  const e = new Editor({ extensions: notebookExtensions(), content: '<p><code>foo</code></p>' });
  e.commands.focus('end'); // cursor right after "foo", inside the code mark
  return e;
}
// Run a key through the full keymap cascade (respects extension priority), like a real keypress.
const press = (e: Editor, key: string) =>
  e.view.someProp('handleKeyDown', (f) => f(e.view as EditorView, new KeyboardEvent('keydown', { key })));

describe('inline code smart-exit', () => {
  it('Enter turns the code mark off on the new line', () => {
    const e = codeEditor();
    expect(e.isActive('code')).toBe(true);
    press(e, 'Enter');
    expect(e.isActive('code')).toBe(false);
    e.destroy();
  });

  it('double-space exits code and leaves a single plain (non-code) space', () => {
    const e = codeEditor();
    press(e, ' '); // first space: handler inserts it (still code), preventing a native space
    press(e, ' '); // second space: exits
    expect(e.isActive('code')).toBe(false);
    expect(e.getText()).toBe('foo '); // one trailing space, not two, no period
    e.destroy();
  });
});
