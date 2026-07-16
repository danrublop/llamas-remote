import { describe, it, expect } from 'vitest';
import { parseEdits, stripEdits, applyEdits } from './note-chat-edits';

describe('note-chat edit protocol', () => {
  it('parses find/replace blocks and strips them from prose', () => {
    const msg = 'Sure, tightening that up.\n<<<FIND>>>\nold line\n<<<REPLACE>>>\nnew line\n<<<END>>>\nDone.';
    const edits = parseEdits(msg);
    expect(edits).toEqual([{ find: 'old line', replace: 'new line' }]);
    expect(stripEdits(msg)).toBe('Sure, tightening that up.\n\nDone.');
  });

  it('replaces the first occurrence, appends on empty FIND, and reports misses', () => {
    const base = '# Title\n\nold line\n';
    const r = applyEdits(base, [
      { find: 'old line', replace: 'new line' },
      { find: '', replace: 'appended para' },
      { find: 'nowhere', replace: 'x' },
    ]);
    expect(r.md).toBe('# Title\n\nnew line\n\nappended para\n');
    expect(r.applied).toBe(2);
    expect(r.failed).toBe(1);
  });

  it('falls back to a whitespace-trimmed match', () => {
    expect(applyEdits('a  hello  b', [{ find: 'hello', replace: 'hi' }]).md).toBe('a  hi  b');
  });
});
