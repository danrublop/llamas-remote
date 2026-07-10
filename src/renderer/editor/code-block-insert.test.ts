// @vitest-environment jsdom
// Guards the code-block button behavior (notebook.tsx toggleCode): a new code block holds ONLY
// the selected text (or nothing) — it must not absorb the rest of the current paragraph the way
// toggleCodeBlock() does. Replicates the command the button runs.
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { notebookExtensions } from './extensions';

function insertCodeFromSelection(e: Editor): void {
  const { from, to, empty } = e.state.selection;
  const text = empty ? '' : e.state.doc.textBetween(from, to, '\n');
  e.chain().focus().insertContent({ type: 'codeBlock', content: text ? [{ type: 'text', text }] : [] }).run();
}

const codeBlocks = (e: Editor): string[] => {
  const out: string[] = [];
  e.state.doc.descendants((n) => { if (n.type.name === 'codeBlock') out.push(n.textContent); });
  return out;
};

describe('code-block button', () => {
  it('wraps only the selected text, leaving the rest as prose', () => {
    const e = new Editor({ extensions: notebookExtensions(), content: 'keep this AND code', contentType: 'markdown' });
    // Select "code" (last 4 chars).
    const end = e.state.doc.content.size - 1;
    e.commands.setTextSelection({ from: end - 4, to: end });
    insertCodeFromSelection(e);
    expect(codeBlocks(e)).toEqual(['code']);
    expect(e.getText()).toContain('keep this AND'); // surrounding prose survives, not absorbed
    e.destroy();
  });

  it('inserts an empty code block when nothing is selected', () => {
    const e = new Editor({ extensions: notebookExtensions(), content: 'untouched line', contentType: 'markdown' });
    e.commands.setTextSelection(e.state.doc.content.size - 1); // caret at end of line, no selection
    insertCodeFromSelection(e);
    expect(codeBlocks(e)).toEqual(['']); // empty block, no text pulled in
    expect(e.getText()).toContain('untouched line'); // original line preserved intact
    e.destroy();
  });
});
