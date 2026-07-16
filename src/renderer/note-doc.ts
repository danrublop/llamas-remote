// The companion-document protocol for a chat: the agent writes a note that appears in a split pane
// beside the chat, and both sides edit it. Two primitives, both reused from note-chat-edits:
//
//   <<<DOC title: Grocery list>>>   ← create or fully rewrite the document (title optional)
//   - milk
//   <<<END>>>
//
//   <<<FIND>>>old<<<REPLACE>>>new<<<END>>>   ← a surgical edit that keeps everything around it
//
// FIND/REPLACE is what makes it collaborative: it edits around the user's own changes instead of
// clobbering the whole doc. DOC is for starting the document (or an explicit "rewrite it").
// Pure + separate from React so it unit-tests without the editor.

import { parseEdits, applyEdits, stripEdits, type NoteEdit } from './note-chat-edits';

export interface DocWrite { title?: string; body: string }
export interface DocOps { write: DocWrite | null; edits: NoteEdit[] }

// title is anything up to the closing >>> on the same line; body runs to <<<END>>>. Non-greedy so
// the first END closes it, and distinct from FIND/REPLACE (which opens with <<<FIND>>>).
const DOC = /<<<DOC(?:\s+title:\s*([^\n>]*))?>>>\r?\n?([\s\S]*?)\r?\n?<<<END>>>/;

export function parseDocOps(text: string): DocOps {
  const m = text.match(DOC);
  const write = m ? { title: (m[1] ?? '').trim() || undefined, body: m[2] } : null;
  return { write, edits: parseEdits(text) };
}

export function hasDocOps(ops: DocOps): boolean {
  return !!ops.write || ops.edits.length > 0;
}

/** The prose the agent wrote around its blocks — both DOC and FIND/REPLACE removed. */
export function stripDocOps(text: string): string {
  return stripEdits(text.replace(DOC, '')); // stripEdits removes FIND/REPLACE, collapses, trims
}

/**
 * Apply the ops to the doc's current Markdown. A DOC write replaces the whole body first; then any
 * FIND/REPLACE edits land on top. Edits whose FIND can't be found are counted in `failed`, never
 * silently dropped.
 */
export function applyDocOps(base: string, ops: DocOps): { md: string; title?: string; applied: number; failed: number } {
  let md = base;
  let applied = 0;
  let failed = 0;
  if (ops.write) { md = ops.write.body.trim() + '\n'; applied++; }
  if (ops.edits.length) { const r = applyEdits(md, ops.edits); md = r.md; applied += r.applied; failed += r.failed; }
  return { md, title: ops.write?.title, applied, failed };
}

/** A short human line for the chat chip: "Wrote the document", "3 edits to the document". */
export function describeDocOps(ops: DocOps): string {
  if (ops.write && ops.edits.length) return `Wrote the document, then ${ops.edits.length} edit${ops.edits.length === 1 ? '' : 's'}`;
  if (ops.write) return ops.write.title ? `Wrote “${ops.write.title}”` : 'Wrote the document';
  const n = ops.edits.length;
  return `${n} edit${n === 1 ? '' : 's'} to the document`;
}
