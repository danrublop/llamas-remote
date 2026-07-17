import { describe, it, expect } from 'vitest';
import { parseDocOps, hasDocOps, stripDocOps, applyDocOps, describeDocOps } from './note-doc';

const doc = (title = 'Grocery list', body = '- milk\n- eggs') =>
  `<<<DOC title: ${title}>>>\n${body}\n<<<END>>>`;
const edit = (find: string, replace: string) => `<<<FIND>>>\n${find}\n<<<REPLACE>>>\n${replace}\n<<<END>>>`;

describe('parseDocOps', () => {
  it('reads a DOC write with a title', () => {
    const ops = parseDocOps(`Here you go.\n\n${doc()}`);
    expect(ops.write).toEqual({ title: 'Grocery list', body: '- milk\n- eggs' });
    expect(ops.edits).toEqual([]);
  });

  it('reads a DOC write with no title', () => {
    expect(parseDocOps('<<<DOC>>>\nhello\n<<<END>>>').write).toEqual({ title: undefined, body: 'hello' });
  });

  it('reads FIND/REPLACE edits alongside prose', () => {
    const ops = parseDocOps(`Fixing that.\n\n${edit('milk', 'oat milk')}`);
    expect(ops.write).toBeNull();
    expect(ops.edits).toEqual([{ find: 'milk', replace: 'oat milk' }]);
  });

  it('finds nothing in an ordinary reply', () => {
    const ops = parseDocOps('Your list already looks complete.');
    expect(hasDocOps(ops)).toBe(false);
  });
});

describe('stripDocOps', () => {
  it('drops both block kinds and keeps the prose', () => {
    expect(stripDocOps(`Done.\n\n${doc()}\n\nWant anything else?`)).toBe('Done.\n\nWant anything else?');
    expect(stripDocOps(`Tweaked it.\n\n${edit('a', 'b')}`)).toBe('Tweaked it.');
  });
});

describe('applyDocOps', () => {
  it('writes the whole doc from a DOC block', () => {
    const r = applyDocOps('old content', parseDocOps(doc()));
    expect(r.md).toBe('- milk\n- eggs\n');
    expect(r.title).toBe('Grocery list');
    expect(r).toMatchObject({ applied: 1, failed: 0 });
  });

  it('edits around the user’s own text instead of replacing it', () => {
    const base = '- milk\n- eggs\n- my own line I added\n';
    const r = applyDocOps(base, parseDocOps(edit('- milk', '- oat milk')));
    expect(r.md).toBe('- oat milk\n- eggs\n- my own line I added\n');
    expect(r).toMatchObject({ applied: 1, failed: 0 });
  });

  it('applies a write and then edits on top of it', () => {
    const ops = parseDocOps(`${doc('List', '- a\n- b')}\n${edit('- a', '- A')}`);
    const r = applyDocOps('', ops);
    expect(r.md).toBe('- A\n- b\n');
    expect(r.applied).toBe(2);
  });

  it('counts an edit that matches nothing as failed, without corrupting the doc', () => {
    const r = applyDocOps('- milk\n', parseDocOps(edit('bread', 'sourdough')));
    expect(r.md).toBe('- milk\n');
    expect(r).toMatchObject({ applied: 0, failed: 1 });
  });
});

describe('describeDocOps', () => {
  it('summarizes each shape', () => {
    expect(describeDocOps(parseDocOps(doc()))).toBe('Wrote “Grocery list”');
    expect(describeDocOps(parseDocOps('<<<DOC>>>\nx\n<<<END>>>'))).toBe('Wrote the document');
    expect(describeDocOps(parseDocOps(edit('a', 'b')))).toBe('1 edit to the document');
    expect(describeDocOps(parseDocOps(`${edit('a', 'b')}${edit('c', 'd')}`))).toBe('2 edits to the document');
  });
});
