// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { notebookExtensions } from './extensions';
import { markdownToDoc } from './reconstruct';

// Day pages are Markdown on disk, so the event container + task-list todos must survive a full
// markdown → doc → markdown trip unchanged (files are the source of truth).
function roundtrip(md: string): string {
  const e = new Editor({ extensions: notebookExtensions() });
  e.commands.setContent(markdownToDoc(md, [], []));
  const out = (e as unknown as { getMarkdown: () => string }).getMarkdown();
  e.destroy();
  return out.trimEnd();
}

describe('calendar day markdown round-trip', () => {
  it('preserves an event container (start–end) with text above and below', () => {
    const md = 'before\n\n<div data-cal-event data-title="Exam &quot;2&quot;" data-start="09:30" data-end="10:45" data-color="#ef4444"></div>\n\nafter';
    expect(roundtrip(md)).toBe(md);
  });
  it('migrates a legacy single-time (data-time) event to data-start', () => {
    const md = '<div data-cal-event data-title="x" data-time="09:30" data-color="#3b82f6"></div>';
    const out = roundtrip(md);
    expect(out).toContain('data-start="09:30"');
    expect(out).not.toContain('data-time=');
  });
  it('preserves checkbox to-dos', () => {
    expect(roundtrip('- [x] done\n- [ ] todo')).toBe('- [x] done\n- [ ] todo');
  });
  it('sanitizes an out-of-allowlist color to the default', () => {
    const md = '<div data-cal-event data-title="x" data-start="" data-end="" data-color="javascript:alert(1)"></div>';
    expect(roundtrip(md)).toContain('data-color="#3b82f6"');
  });
});
