// Calendar tools for the chat agent: a text protocol the model writes, that we parse and apply to
// the calendar's day pages. Same shape as note-chat-edits.ts (the FIND/REPLACE note protocol) —
// blocks in the reply, parsed out, applied on the user's click.
//
//   <<<CAL ADD>>>            <<<CAL MOVE>>>           <<<CAL DELETE>>>
//   date: 2026-07-20         date: 2026-07-20         date: 2026-07-20
//   title: CSE 214           match: CSE 214           match: CSE 214
//   start: 09:30             to: 2026-07-21           <<<END>>>
//   end: 12:45               start: 10:00
//   color: #3b82f6           end: 13:15
//   <<<END>>>                <<<END>>>
//
// Why a text protocol and not native tool-calling: it works on every provider this app routes to,
// including small local Ollama models that handle tools badly or not at all — and this is a
// local-first app. It also keeps a human in the loop, which matters when the thing being rewritten
// is the user's own calendar: the model proposes, the user clicks Apply.
//
// Model output is untrusted (CLAUDE.md). Nothing here is eval'd or injected as HTML: fields are
// matched by strict regex, dates/times must parse, and colour is allowlisted. Anything else is a
// rejected op, not a mangled calendar.

import {
  ISO_RE, eventsOf, appendEvent, removeEventAt, replaceEventAt, toMin, hhmm, DEFAULT_MIN,
  type CalEvent, type Days,
} from './day-page';

export type CalOp =
  | { kind: 'add'; date: string; title: string; start: string; end: string; color: string }
  | { kind: 'move'; date: string; match: string; to: string; start: string; end: string }
  | { kind: 'delete'; date: string; match: string };

const BLOCK = /<<<CAL (ADD|MOVE|DELETE)>>>\r?\n([\s\S]*?)<<<END>>>/gi;
const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const DEFAULT_COLOR = '#3b82f6';

/** One "key: value" line per field; unknown keys are ignored rather than failing the block. */
function fields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const m = /^\s*(\w+)\s*:\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

// '' is allowed (an event needn't have a time); nonsense is not.
const time = (v: string | undefined) => (v && toMin(v) !== null ? v : '');

/**
 * Pull every well-formed calendar op out of a model reply. A block that's missing its date, or
 * naming something that isn't a real date, is dropped here rather than half-applied later.
 */
export function parseCalOps(text: string): CalOp[] {
  const ops: CalOp[] = [];
  for (const m of text.matchAll(BLOCK)) {
    const kind = m[1].toLowerCase();
    const f = fields(m[2]);
    if (!ISO_RE.test(f.date || '')) continue;
    if (kind === 'add') {
      if (!f.title?.trim()) continue;
      const start = time(f.start);
      // An end before its start is the model's arithmetic slipping; treat it as unset rather than
      // writing a backwards event.
      const end = time(f.end);
      const ok = start && end && toMin(end)! > toMin(start)!;
      ops.push({
        kind: 'add', date: f.date, title: f.title.trim(), start,
        end: ok ? end : start ? hhmm(toMin(start)! + DEFAULT_MIN) : '',
        color: SAFE_COLOR.test(f.color || '') ? f.color : DEFAULT_COLOR,
      });
    } else if (kind === 'move') {
      if (!f.match?.trim()) continue;
      const to = ISO_RE.test(f.to || '') ? f.to : f.date;
      ops.push({ kind: 'move', date: f.date, match: f.match.trim(), to, start: time(f.start), end: time(f.end) });
    } else if (kind === 'delete') {
      if (!f.match?.trim()) continue;
      ops.push({ kind: 'delete', date: f.date, match: f.match.trim() });
    }
  }
  return ops;
}

/** The reply with its op blocks removed — the prose the model wrote around them. */
export function stripCalOps(text: string): string {
  return text.replace(BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
}

// The model can't know an event's index, so it names one by title. Case-insensitive, and a
// substring counts — "CSE 214" should find "CSE 214 Lecture".
function findEvent(evs: CalEvent[], match: string): number {
  const m = match.toLowerCase();
  const exact = evs.findIndex((e) => e.title.toLowerCase() === m);
  return exact >= 0 ? exact : evs.findIndex((e) => e.title.toLowerCase().includes(m));
}

/**
 * Apply ops to the day map, returning a new one. An op naming an event that isn't there counts as
 * failed and is skipped — the caller reports that rather than pretending it worked.
 */
export function applyCalOps(days: Days, ops: CalOp[]): { days: Days; applied: number; failed: number } {
  const next = { ...days };
  let applied = 0, failed = 0;
  for (const op of ops) {
    const md = next[op.date] || '';
    if (op.kind === 'add') {
      next[op.date] = appendEvent(md, { title: op.title, start: op.start, end: op.end, color: op.color });
      applied++;
      continue;
    }
    const evs = eventsOf(md);
    const i = findEvent(evs, op.match);
    if (i < 0) { failed++; continue; }
    if (op.kind === 'delete') {
      next[op.date] = removeEventAt(md, i);
      applied++;
      continue;
    }
    // move: keep whatever the model didn't specify — an op that only says `to` shifts the day and
    // leaves the times alone.
    const moved: CalEvent = { ...evs[i], start: op.start || evs[i].start, end: op.end || evs[i].end };
    if (op.to === op.date) next[op.date] = replaceEventAt(md, i, moved);
    else {
      next[op.date] = removeEventAt(md, i);
      next[op.to] = appendEvent(next[op.to] || '', moved);
    }
    applied++;
  }
  return { days: next, applied, failed };
}

/** One-line human summary of an op, for the Apply card. */
export function describeOp(op: CalOp): string {
  if (op.kind === 'add') return `Add “${op.title}” on ${op.date}${op.start ? ` at ${op.start}` : ''}`;
  if (op.kind === 'delete') return `Delete “${op.match}” from ${op.date}`;
  const when = op.start ? ` at ${op.start}` : '';
  return op.to === op.date ? `Move “${op.match}”${when || ' on ' + op.date}` : `Move “${op.match}” to ${op.to}${when}`;
}
