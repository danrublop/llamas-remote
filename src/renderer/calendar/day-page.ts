// The calendar's data layer: reading and writing the day pages that are its source of truth.
//
// A day is plain Markdown, keyed by date in the calendar note's body ({"days":{"2026-07-14":"…"}}).
// Events live inside it as `<div data-cal-event …></div>` tags (see editor/event.ts), so a day page
// stays a document you can type in, with events as structured blocks among your prose.
//
// Pure and React-free on purpose: the calendar view, its tests, and the chat agent's calendar tools
// all need this logic, and only one of those can import a component.

import { eventHtml } from '../editor/event';

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const fromIso = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const weekStart = (d: Date) => addDays(d, -d.getDay());
export const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$/;

export type Days = Record<string, string>; // date → day-page Markdown

/** An event as the views need it — read back out of a day page's Markdown. */
export interface CalEvent { title: string; start: string; end: string; color: string }

// Attribute values are escaped on write, so `>` can never appear inside one and [^>]* is a safe way
// to bound a tag.
const EVENT_RE = /<div\b[^>]*\bdata-cal-event\b[^>]*>\s*<\/div>/g;

// Read events out of a day page. Attributes are parsed with DOMParser rather than more regex —
// parseFromString builds an inert document (no script execution, no loads) and we only read
// attributes off it. Nothing re-enters the DOM as HTML: titles render as React children, and color
// is re-validated against SAFE_COLOR before it can reach a style.
//
// Indices matter: the writers below address an event by its position here, so both walk the same
// EVENT_RE matches. Letting querySelectorAll and a regex disagree on what counts as an event would
// mean a drag silently rewriting the wrong one.
export function eventsOf(md: string): CalEvent[] {
  if (!md.includes('data-cal-event')) return [];
  return Array.from(md.matchAll(EVENT_RE), (m) => {
    const el = new DOMParser().parseFromString(m[0], 'text/html').querySelector('div[data-cal-event]');
    const color = el?.getAttribute('data-color') || '';
    return {
      title: el?.getAttribute('data-title') || '',
      start: el?.getAttribute('data-start') || el?.getAttribute('data-time') || '',
      end: el?.getAttribute('data-end') || '',
      color: SAFE_COLOR.test(color) ? color : '#3b82f6',
    };
  });
}

// Where the i-th event's tag sits in the source, or null if there's no such event.
function spanOf(md: string, i: number): [number, number] | null {
  const m = Array.from(md.matchAll(EVENT_RE))[i];
  return m?.index === undefined ? null : [m.index, m.index + m[0].length];
}

/** Rewrite the i-th event in place, leaving the rest of the day's Markdown untouched. */
export function replaceEventAt(md: string, i: number, ev: CalEvent): string {
  const at = spanOf(md, i);
  return at ? md.slice(0, at[0]) + eventHtml(ev) + md.slice(at[1]) : md;
}

/** Drop the i-th event, closing up the blank lines it leaves behind. */
export function removeEventAt(md: string, i: number): string {
  const at = spanOf(md, i);
  if (!at) return md;
  return (md.slice(0, at[0]) + md.slice(at[1])).replace(/\n{3,}/g, '\n\n').trim();
}

/** Append an event to a day page, below whatever is already there. */
export function appendEvent(md: string, ev: CalEvent): string {
  return md.trim() ? `${md.trimEnd()}\n\n${eventHtml(ev)}` : eventHtml(ev);
}

/** Minutes since midnight → the "HH:MM" a day page stores. Clamped to a real time of day. */
export function hhmm(min: number): string {
  const m = Math.max(0, Math.min(Math.round(min), 24 * 60 - 1));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Minutes since midnight, or null for '' / anything hand-edited into nonsense. */
export function toMin(t: string): number | null {
  const hm = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!hm) return null;
  const h = Number(hm[1]), m = Number(hm[2]);
  return h > 23 || m > 59 ? null : h * 60 + m;
}

/** "14:30" → "2:30pm" (day pages store 24h, as native <input type=time> gives). */
export function fmtTime(t: string): string {
  const min = toMin(t);
  if (min === null) return ''; // '' and junk format to nothing, not '12am'
  const h = Math.floor(min / 60), m = min % 60;
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
}

export const DEFAULT_MIN = 60;   // an event with no end time occupies an hour
export const MIN_BLOCK = 30;     // ...and never renders shorter than this, so it stays readable

// A timed event placed on the week grid: where it sits vertically, and which of `lanes`
// side-by-side columns it takes when it overlaps its neighbours. `idx` is its index in the day's
// events — laying out sorts by time, so it's the only way back to the right tag when writing.
export interface Placed { ev: CalEvent; idx: number; startMin: number; endMin: number; lane: number; lanes: number }

/**
 * Lay one day's timed events onto the grid. Overlapping events are packed into lanes and split the
 * column's width, the way Apple's week view does it:
 *
 *   09:30–12:45 ┃ 10:00–11:45 ┃      ← one cluster, 2 lanes, each 50% wide
 *   13:00–14:10 ┃                    ← no overlap, back to 1 lane, full width
 *
 * Events with no usable start time are not placed — the caller shows those in the all-day row.
 */
export function layoutDay(evs: CalEvent[]): Placed[] {
  const timed = evs
    .map((ev, idx) => {
      const startMin = toMin(ev.start);
      if (startMin === null) return null;
      const rawEnd = toMin(ev.end);
      const endMin = rawEnd !== null && rawEnd > startMin ? rawEnd : startMin + DEFAULT_MIN;
      return { ev, idx, startMin, endMin: Math.min(endMin, 24 * 60) };
    })
    .filter((p): p is { ev: CalEvent; idx: number; startMin: number; endMin: number } => p !== null)
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let laneEnds: number[] = []; // lane index → end minute of the last event in it
  let clusterEnd = -1;
  // A cluster is closed once an event starts after everything before it has ended; only then do we
  // know how many lanes it needed, and every member shares that width.
  const flush = () => {
    if (!cluster.length) return;
    const lanes = Math.max(...cluster.map((p) => p.lane)) + 1;
    for (const p of cluster) p.lanes = lanes;
    out.push(...cluster);
    cluster = [];
  };

  for (const t of timed) {
    if (t.startMin >= clusterEnd) { flush(); laneEnds = []; }
    let lane = laneEnds.findIndex((end) => end <= t.startMin);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = t.endMin;
    cluster.push({ ...t, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, t.endMin);
  }
  flush();
  return out;
}

/** Same-weekday dates strictly after `from`, up to and including `until` (weekly cadence). */
export function weeklyDates(from: string, until: string): string[] {
  const end = fromIso(until);
  const out: string[] = [];
  for (let d = addDays(fromIso(from), 7); d <= end; d = addDays(d, 7)) out.push(iso(d));
  return out;
}

/**
 * Read the calendar note's body. Tolerant: reads the current {days:{iso:md}} shape AND migrates the
 * old one ({events:[…], days:{iso:{note,todos}}}) into day Markdown, so no data is lost on upgrade.
 */
export function parseDays(body: string | null): Days {
  const out: Days = {};
  try {
    const o = JSON.parse(body || '{}');
    if (o.days && typeof o.days === 'object') {
      for (const [k, v] of Object.entries(o.days)) {
        if (typeof v === 'string') out[k] = v;
        else if (v && typeof v === 'object') out[k] = legacyDayToMd(v as { note?: string; todos?: { text: string; done: boolean }[] });
      }
    }
    if (Array.isArray(o.events)) {
      for (const e of o.events) {
        if (!e || typeof e.date !== 'string') continue;
        const html = eventHtml({ title: String(e.title || ''), start: String(e.time || ''), end: '', color: e.color });
        out[e.date] = html + '\n\n' + (out[e.date] || '');
      }
    }
  } catch { /* ignore */ }
  return out;
}

/** The calendar note's body, with empty days dropped so the file stays tidy. */
export function serializeDays(days: Days): string {
  const trimmed: Days = {};
  for (const [k, v] of Object.entries(days)) if (v && v.trim()) trimmed[k] = v;
  return JSON.stringify({ days: trimmed });
}

function legacyDayToMd(d: { note?: string; todos?: { text: string; done: boolean }[] }): string {
  const parts: string[] = [];
  if (d.todos?.length) parts.push(d.todos.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n'));
  if (d.note?.trim()) parts.push(d.note.trim());
  return parts.join('\n\n');
}
