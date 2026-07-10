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

  // Cell text after each `md -> doc -> md -> doc` round-trip. Regression guard for the custom
  // table serializer (TableMd) that escapes `|`; the built-in serializer dropped everything
  // after a literal pipe in a cell.
  function tableCells(md: string): string[] {
    const first = new Editor({ extensions: notebookExtensions(), content: md, contentType: 'markdown' });
    const out = first.getMarkdown();
    first.destroy();
    const second = new Editor({ extensions: notebookExtensions(), content: out, contentType: 'markdown' });
    const cells: string[] = [];
    second.state.doc.descendants((n) => { if (n.isText && n.text) cells.push(n.text); });
    second.destroy();
    return cells;
  }

  it('preserves a literal pipe in a table cell (no truncation)', () => {
    // `grep x | wc` must survive — the built-in serializer dropped ` wc` after the pipe.
    expect(tableCells('| H |\n| --- |\n| grep x \\| wc |')).toContain('grep x | wc');
  });

  it('preserves double-pipe and inline formatting in cells', () => {
    const cells = tableCells('| A | B |\n| --- | --- |\n| a \\|\\| b | **bold** |');
    expect(cells).toContain('a || b');
    expect(cells).toContain('bold');
  });

  it('round-trips a Tab-indented paragraph, preserving inner formatting', () => {
    const doc = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        attrs: { indent: 2 },
        content: [
          { type: 'text', text: 'see ' },
          { type: 'text', marks: [{ type: 'bold' }], text: 'bold' },
          { type: 'text', text: ' and ' },
          { type: 'text', marks: [{ type: 'link', attrs: { href: 'https://x.com' } }], text: 'link' },
        ],
      }],
    };
    const md = jsonToMd(doc);
    expect(md).toContain('margin-left: 5em'); // 2 levels × 2.5em
    // Reload and confirm the indent level AND the inner bold/link survived (not flattened to text).
    const reloaded = new Editor({ extensions: notebookExtensions(), content: md, contentType: 'markdown' });
    const json = JSON.stringify(reloaded.getJSON());
    reloaded.destroy();
    expect(json).toContain('"indent":2');
    expect(json).toContain('"bold"');
    expect(json).toContain('https://x.com');
  });

  it('round-trips per-selection font-family and font-size (textStyle mark)', () => {
    const doc = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'text',
          marks: [{ type: 'textStyle', attrs: { fontFamily: 'Georgia', fontSize: '24px' } }],
          text: 'styled',
        }],
      }],
    };
    const md = jsonToMd(doc);
    expect(md).toContain('font-family: Georgia');
    expect(md).toContain('font-size: 24px');
    // And the styled span reloads back into the mark rather than being dropped.
    const reloaded = new Editor({ extensions: notebookExtensions(), content: md, contentType: 'markdown' });
    const json = JSON.stringify(reloaded.getJSON());
    reloaded.destroy();
    expect(json).toContain('Georgia');
    expect(json).toContain('24px');
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
