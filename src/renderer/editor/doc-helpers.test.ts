// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { notebookExtensions } from './extensions';
import { findAiBlock, setAiBlockText, setAiBlockAttrs, setAiBlockMarkdown, collectAiBlocks } from './doc-helpers';

function editorWithBlock(blockId: string) {
  return new Editor({
    extensions: notebookExtensions(),
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
        { type: 'aiBlock', attrs: { blockId, model: 'llama3.2', state: 'generating' }, content: [{ type: 'paragraph' }] },
      ],
    },
  });
}

describe('findAiBlock', () => {
  it('locates an aiBlock by id', () => {
    const e = editorWithBlock('B1');
    const hit = findAiBlock(e, 'B1');
    expect(hit).not.toBeNull();
    expect(hit?.attrs.model).toBe('llama3.2');
    e.destroy();
  });

  it('returns null for a missing id', () => {
    const e = editorWithBlock('B1');
    expect(findAiBlock(e, 'nope')).toBeNull();
    e.destroy();
  });
});

describe('setAiBlockText (cumulative streaming)', () => {
  it('replaces the block content with the cumulative text', () => {
    const e = editorWithBlock('B1');
    expect(setAiBlockText(e, 'B1', 'Hello')).toBe(true);
    expect(setAiBlockText(e, 'B1', 'Hello world')).toBe(true); // cumulative update
    const md = e.getMarkdown();
    expect(md).toContain('<!--ai:B1-->');
    expect(md).toContain('Hello world');
    expect(md).not.toContain('Hello world world'); // not appending deltas
    e.destroy();
  });

  it('is a no-op (false) when the block was removed mid-stream', () => {
    const e = editorWithBlock('B1');
    expect(setAiBlockText(e, 'gone', 'late token')).toBe(false);
    e.destroy();
  });

  it('leaves surrounding prose intact', () => {
    const e = editorWithBlock('B1');
    setAiBlockText(e, 'B1', 'answer');
    expect(e.getMarkdown()).toContain('intro');
    e.destroy();
  });
});

describe('setAiBlockAttrs', () => {
  it('patches transient state without throwing', () => {
    const e = editorWithBlock('B1');
    expect(setAiBlockAttrs(e, 'B1', { state: 'error' })).toBe(true);
    expect(findAiBlock(e, 'B1')?.attrs.state).toBe('error');
    e.destroy();
  });
});

describe('setAiBlockMarkdown (finding #4: final answer parsed into real nodes)', () => {
  it('renders a markdown list/heading as real nodes, not literal text', () => {
    const e = editorWithBlock('B1');
    expect(setAiBlockMarkdown(e, 'B1', '## Result\n\n- one\n- two')).toBe(true);
    const json = JSON.stringify(e.getJSON());
    // real structure, not a single paragraph of "## Result - one - two"
    expect(json).toContain('"heading"');
    expect(json).toContain('"bulletList"');
    e.destroy();
  });

  it('round-trips the parsed answer back to clean markdown (not escaped prose)', () => {
    const e = editorWithBlock('B1');
    setAiBlockMarkdown(e, 'B1', '# Title\n\n- a\n- b');
    const md = e.getMarkdown();
    expect(md).toContain('# Title');
    expect(md).toContain('- a');
    expect(md).not.toContain('\\# Title'); // not escaped
    expect(md).toContain('<!--ai:B1-->'); // still inside the AI block
    e.destroy();
  });

  it('is a no-op when the block was removed mid-stream', () => {
    const e = editorWithBlock('B1');
    expect(setAiBlockMarkdown(e, 'gone', '# x')).toBe(false);
    e.destroy();
  });

  it('falls back to literal text without blanking the block on empty answer', () => {
    const e = editorWithBlock('B1');
    expect(setAiBlockMarkdown(e, 'B1', '')).toBe(true);
    expect(findAiBlock(e, 'B1')).not.toBeNull();
    e.destroy();
  });

  it('preserves the surrounding prose', () => {
    const e = editorWithBlock('B1');
    setAiBlockMarkdown(e, 'B1', 'plain answer');
    expect(e.getMarkdown()).toContain('intro');
    e.destroy();
  });
});

describe('collectAiBlocks', () => {
  it('collects blocks with re-run inputs, in order, skipping id-less blocks', () => {
    const e = new Editor({
      extensions: notebookExtensions(),
      content: {
        type: 'doc',
        content: [
          { type: 'aiBlock', attrs: { blockId: 'b1', model: 'm', prompt: 'Explain', commandId: 'explain', selection: 'code' }, content: [{ type: 'paragraph' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'mid' }] },
          { type: 'aiBlock', attrs: { blockId: null }, content: [{ type: 'paragraph' }] }, // no id -> skipped
          { type: 'aiBlock', attrs: { blockId: 'b2', model: 'm2' }, content: [{ type: 'paragraph' }] },
        ],
      },
    });
    const blocks = collectAiBlocks(e);
    expect(blocks.map((b) => b.blockId)).toEqual(['b1', 'b2']);
    expect(blocks[0]).toEqual({ blockId: 'b1', prompt: 'Explain', model: 'm', commandId: 'explain', selection: 'code' });
    expect(blocks[1]).toEqual({ blockId: 'b2', prompt: '', model: 'm2', commandId: undefined, selection: undefined });
    e.destroy();
  });
});
