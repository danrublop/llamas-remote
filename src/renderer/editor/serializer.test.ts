// @vitest-environment jsdom
//
// Golden round-trip tests for the notebook Markdown serializer (eng-review CI gate).
// Runs the real TipTap schema headless in jsdom: markdown -> doc -> markdown must be
// stable for every standard node type, and the AI block must serialize to its anchor.

import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { notebookExtensions } from './extensions';

function mdToMd(md: string): string {
  const editor = new Editor({ extensions: notebookExtensions(), content: md, contentType: 'markdown' });
  const out = editor.getMarkdown();
  editor.destroy();
  return out.trim();
}

function jsonToMd(doc: object): string {
  const editor = new Editor({ extensions: notebookExtensions(), content: doc as never });
  const out = editor.getMarkdown();
  editor.destroy();
  return out.trim();
}

describe('markdown round-trip (md -> doc -> md identity)', () => {
  const cases: Array<[string, string]> = [
    ['heading', '# Title'],
    ['paragraph with emphasis', 'Hello **bold** and *italic* and `code`.'],
    ['unordered list', '- one\n- two'],
    ['ordered list', '1. first\n2. second'],
    ['blockquote', '> quoted text'],
    ['link', '[docs](https://example.com)'],
  ];
  it.each(cases)('round-trips %s', (_name, md) => {
    expect(mdToMd(md)).toBe(md);
  });

  it('round-trips a fenced code block', () => {
    const md = '```\nconst x = 1;\n```';
    expect(mdToMd(md)).toContain('const x = 1;');
    expect(mdToMd(md).startsWith('```')).toBe(true);
  });

  it('round-trips a GFM table (survives save/reload — no data loss)', () => {
    const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    const out = mdToMd(md);
    // A GFM pipe table with the header separator + the cell values must survive.
    expect(out).toContain('| --- |');
    expect(out).toContain('A');
    expect(out).toContain('1');
    // And it reloads as a real table node, not plain text.
    const editor = new Editor({ extensions: notebookExtensions(), content: md, contentType: 'markdown' });
    expect(JSON.stringify(editor.getJSON())).toContain('"table"');
    editor.destroy();
  });
});

describe('AiBlock serialization', () => {
  it('serializes an AI block to its anchor comment + inner markdown', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        {
          type: 'aiBlock',
          attrs: { blockId: '01ABC', model: 'llama3.2' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'generated answer' }] }],
        },
      ],
    };
    const md = jsonToMd(doc);
    expect(md).toContain('<!--ai:01ABC-->');
    expect(md).toContain('generated answer');
    // anchor comes immediately before the generated content
    expect(md.indexOf('<!--ai:01ABC-->')).toBeLessThan(md.indexOf('generated answer'));
    // the prose before the block is preserved
    expect(md).toContain('before');
  });

  it('emits an empty-id anchor when blockId is missing (degrades, never throws)', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'aiBlock', attrs: { blockId: null, model: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }],
    };
    expect(jsonToMd(doc)).toContain('<!--ai:-->');
  });
});
