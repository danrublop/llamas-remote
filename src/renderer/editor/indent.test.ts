// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { notebookExtensions } from './extensions';
import { MAX_INDENT, leadingWhitespace, codeBlockEnter } from './indent';

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

describe('leadingWhitespace (code-block auto-indent)', () => {
  const code = 'class A {\n    int x = 1;\n        deep();';
  it('returns the current line indent up to the cursor', () => {
    expect(leadingWhitespace(code, code.length)).toBe('        '); // inside "deep" line
    expect(leadingWhitespace('    x', 5)).toBe('    ');
    expect(leadingWhitespace('noindent', 8)).toBe('');
    expect(leadingWhitespace(code, 9)).toBe(''); // right after first "\n" → new empty line
  });
});

describe('codeBlockEnter (IDE auto-indent)', () => {
  it('carries the current line indent by default', () => {
    const t = '    foo();';
    expect(codeBlockEnter(t, t.length)).toEqual({ insert: '\n    ', caretBack: 0 });
  });
  it('indents one step deeper after an opener at line end', () => {
    const t = 'class A {';
    expect(codeBlockEnter(t, t.length)).toEqual({ insert: '\n  ', caretBack: 0 });
    const t2 = '    if (x) {';
    expect(codeBlockEnter(t2, t2.length)).toEqual({ insert: '\n      ', caretBack: 0 });
  });
  it('electric-expands when the cursor sits inside a matching pair', () => {
    const t = '    if (x) {}';
    // cursor between { and }
    const at = t.length - 1;
    expect(codeBlockEnter(t, at)).toEqual({ insert: '\n      \n    ', caretBack: 5 });
  });
});
