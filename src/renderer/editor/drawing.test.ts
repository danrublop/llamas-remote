// @vitest-environment jsdom
//
// Round-trip for the Drawing node: a drawing serializes to its invisible anchor + a viewable
// PNG image line, and reconstructs from the raw Markdown + the sidecar scene — the scene must
// survive a save/reload, and interleaved ai/draw/plain segments must stay in document order.

import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { notebookExtensions } from './extensions';
import { markdownToDoc, splitSegments } from './reconstruct';
import type { JSONContent } from '@tiptap/core';

function jsonToMd(doc: object): string {
  const editor = new Editor({ extensions: notebookExtensions(), content: doc as never });
  const out = editor.getMarkdown();
  editor.destroy();
  return out.trim();
}

const drawingDoc = (id: string): object => ({
  type: 'doc',
  content: [{ type: 'drawing', attrs: { drawingId: id, scene: { should: 'not serialize' } } }],
});

describe('Drawing serialize', () => {
  it('serializes to an anchor + a viewable PNG image (scene stays out of the Markdown)', () => {
    const md = jsonToMd(drawingDoc('abc123'));
    expect(md).toContain('<!--draw:abc123-->');
    expect(md).toContain('![drawing](images/draw-abc123.png)');
    expect(md).not.toContain('not serialize');
  });
});

describe('Drawing reconstruct', () => {
  it('rebuilds the drawing node and rehydrates its scene from the sidecar', () => {
    const md = '<!--draw:abc123-->\n![drawing](images/draw-abc123.png)';
    const scene = { elements: [{ id: 'x' }] };
    const doc = markdownToDoc(md, [], [{ drawingId: 'abc123', scene }]) as { content: JSONContent[] };
    const draw = doc.content.find((n) => n.type === 'drawing');
    expect(draw).toBeTruthy();
    expect(draw?.attrs?.drawingId).toBe('abc123');
    expect(draw?.attrs?.scene).toEqual(scene);
  });

  it('rebuilds a drawing with no matching sidecar scene as an empty (null-scene) node', () => {
    const md = '<!--draw:orphan-->\n![drawing](images/draw-orphan.png)';
    const doc = markdownToDoc(md, [], []) as { content: JSONContent[] };
    const draw = doc.content.find((n) => n.type === 'drawing');
    expect(draw?.attrs?.scene ?? null).toBeNull();
  });

  it('round-trips the drawing anchor (md -> doc(scene) -> md is stable)', () => {
    const md = '<!--draw:abc123-->\n![drawing](images/draw-abc123.png)';
    const doc = markdownToDoc(md, [], [{ drawingId: 'abc123', scene: { a: 1 } }]);
    expect(jsonToMd(doc)).toContain('<!--draw:abc123-->');
    expect(jsonToMd(doc)).toContain('![drawing](images/draw-abc123.png)');
  });
});

describe('splitSegments keeps ai / drawing / plain in document order', () => {
  it('tokenizes an interleaved body', () => {
    const md = 'intro\n<!--draw:d1-->\n![drawing](images/draw-d1.png)\nmiddle\n<!--ai:a1-->\nanswer\n<!--/ai-->\nend';
    const segs = splitSegments(md);
    // plain(intro), draw(d1), plain(middle), ai(a1), plain(end)
    expect(segs.map((s) => (s.draw ? 'draw' : s.ai ? 'ai' : 'plain'))).toEqual(['plain', 'draw', 'plain', 'ai', 'plain']);
    expect(segs[1].drawingId).toBe('d1');
    expect(segs[3].blockId).toBe('a1');
  });
});
