// FIND/REPLACE edit protocol for the note-side chat panel (adapted from odysseus' document tools).
// The model emits blocks; we apply them as plain-string edits to the note's Markdown, then hand
// the result back to the editor's markdown setContent (which re-parses through the XSS-safe
// ProseMirror schema). Kept pure + separate from React so it's unit-testable.

export interface NoteEdit { find: string; replace: string }

const BLOCK = /<<<FIND>>>\r?\n?([\s\S]*?)\r?\n?<<<REPLACE>>>\r?\n?([\s\S]*?)\r?\n?<<<END>>>/g;

/** Extract every FIND/REPLACE block from a model message. */
export function parseEdits(text: string): NoteEdit[] {
  const edits: NoteEdit[] = [];
  for (const m of text.matchAll(BLOCK)) edits.push({ find: m[1], replace: m[2] });
  return edits;
}

/** The message with its edit blocks removed — the prose the model wrote around them. */
export function stripEdits(text: string): string {
  return text.replace(BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Apply edits to `base` Markdown. Empty FIND ⇒ append REPLACE to the end. Otherwise replace the
 * first occurrence of FIND (falling back to a whitespace-trimmed match). Blocks whose FIND can't
 * be located are counted in `failed` and skipped — never a silent corruption.
 */
export function applyEdits(base: string, edits: NoteEdit[]): { md: string; applied: number; failed: number } {
  let md = base;
  let applied = 0;
  let failed = 0;
  for (const e of edits) {
    if (!e.find.trim()) {
      md = md.replace(/\s*$/, '') + '\n\n' + e.replace.trim() + '\n';
      applied++;
      continue;
    }
    let idx = md.indexOf(e.find);
    let len = e.find.length;
    if (idx < 0) { const t = e.find.trim(); idx = md.indexOf(t); len = t.length; } // whitespace-tolerant
    if (idx < 0) { failed++; continue; }
    md = md.slice(0, idx) + e.replace + md.slice(idx + len);
    applied++;
  }
  return { md, applied, failed };
}
