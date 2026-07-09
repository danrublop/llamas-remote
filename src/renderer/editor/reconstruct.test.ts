// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { notebookExtensions } from './extensions';
import { splitSegments, markdownToDoc } from './reconstruct';
import type { AIBlockMeta } from '../../main/services/notebook/sidecar';

const meta = (blockId: string, model = 'llama3.2'): AIBlockMeta => ({ blockId, model, prompt: `p-${blockId}`, createdAt: '2026-05-26T00:00:00Z' });

// serialize a doc to markdown the way the editor saves it, so we test the real round-trip
function docToMarkdown(doc: object): string {
  const e = new Editor({ extensions: notebookExtensions(), content: doc as never });
  const md = e.getMarkdown();
  e.destroy();
  return md;
}

describe('splitSegments', () => {
  it('splits plain + ai segments in order', () => {
    const md = 'intro\n\n<!--ai:B1-->\nanswer\n<!--/ai-->\n\nouttro';
    const segs = splitSegments(md);
    expect(segs.map((s) => s.ai)).toEqual([false, true, false]);
    expect(segs[1].blockId).toBe('B1');
    expect(segs[1].md).toBe('answer');
  });

  it('returns a single plain segment when there are no markers', () => {
    expect(splitSegments('just text')).toEqual([{ ai: false, md: 'just text' }]);
  });

  it('handles back-to-back ai blocks', () => {
    const md = '<!--ai:A-->\nfirst\n<!--/ai-->\n<!--ai:B-->\nsecond\n<!--/ai-->';
    const segs = splitSegments(md).filter((s) => s.ai);
    expect(segs.map((s) => s.blockId)).toEqual(['A', 'B']);
  });
});

describe('markdownToDoc', () => {
  it('reconstructs an aiBlock with content + sidecar metadata', () => {
    const doc = markdownToDoc('intro\n\n<!--ai:B1-->\ngenerated answer\n<!--/ai-->', [meta('B1')]);
    const ai = (doc.content ?? []).find((n) => n.type === 'aiBlock');
    expect(ai).toBeDefined();
    expect(ai?.attrs?.blockId).toBe('B1');
    expect(ai?.attrs?.model).toBe('llama3.2');
    // the generated text is inside the block
    expect(JSON.stringify(ai?.content)).toContain('generated answer');
    // the intro prose survives as a sibling
    expect(JSON.stringify(doc.content)).toContain('intro');
  });

  it('full round-trip: doc -> markdown -> doc preserves the AI block', () => {
    const original = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'aiBlock', attrs: { blockId: 'X9', model: 'llama3.2' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'the answer' }] }] },
      ],
    };
    const md = docToMarkdown(original);
    expect(md).toContain('<!--ai:X9-->');
    expect(md).toContain('<!--/ai-->');
    const rebuilt = markdownToDoc(md, [meta('X9')]);
    const ai = (rebuilt.content ?? []).find((n) => n.type === 'aiBlock');
    expect(ai?.attrs?.blockId).toBe('X9');
    expect(JSON.stringify(ai?.content)).toContain('the answer');
  });

  it('carries commandId + selection from the sidecar into the block (cross-session re-run)', () => {
    const m: AIBlockMeta = { blockId: 'R1', model: 'llama3.2', prompt: 'Explain', commandId: 'explain', selection: 'const x = 1', createdAt: '2026-05-26T00:00:00Z' };
    const doc = markdownToDoc('<!--ai:R1-->\nans\n<!--/ai-->', [m]);
    const ai = (doc.content ?? []).find((n) => n.type === 'aiBlock');
    expect(ai?.attrs?.commandId).toBe('explain');
    expect(ai?.attrs?.selection).toBe('const x = 1');
  });

  it('degrades to plain prose when no markers are present', () => {
    const doc = markdownToDoc('# Heading\n\njust normal notes', []);
    expect((doc.content ?? []).some((n) => n.type === 'aiBlock')).toBe(false);
    expect(JSON.stringify(doc.content)).toContain('Heading');
  });

  it('reconstructs an anchored block even with no sidecar entry (plain block, null meta)', () => {
    const doc = markdownToDoc('<!--ai:orphan-->\ncontent\n<!--/ai-->', []);
    const ai = (doc.content ?? []).find((n) => n.type === 'aiBlock');
    expect(ai?.attrs?.blockId).toBe('orphan');
    expect(ai?.attrs?.model).toBeNull();
  });
});
