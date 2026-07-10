// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { notebookExtensions } from './extensions';
import { MAX_INDENT } from './indent';

function editorWith(md: string): Editor {
  const e = new Editor({ extensions: notebookExtensions(), content: md, contentType: 'markdown' });
  e.commands.selectAll();
  return e;
}
const indentOf = (e: Editor) => e.state.doc.firstChild?.attrs.indent;

describe('indent / outdent commands', () => {
  it('raises and lowers the block indent level, flooring at 0', () => {
    const e = editorWith('hello');
    expect(indentOf(e)).toBe(0);
    e.commands.indent();
    expect(indentOf(e)).toBe(1);
    e.commands.outdent();
    e.commands.outdent(); // already at 0 — stays put, no throw
    expect(indentOf(e)).toBe(0);
    e.destroy();
  });

  it('caps at MAX_INDENT', () => {
    const e = editorWith('hi');
    for (let i = 0; i < MAX_INDENT + 3; i++) e.commands.indent();
    expect(indentOf(e)).toBe(MAX_INDENT);
    e.destroy();
  });
});
