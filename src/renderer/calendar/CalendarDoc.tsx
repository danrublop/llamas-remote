// The app's single custom calendar (source_kind=calendar, one pinned note). Month / Week / Day
// views over local data stored as JSON in the note body — no backend. Each DAY is a free-form
// page: a full notebook editor you type in, plus a toolbar to drop in "containers" — an event
// box or a to-do checklist — with text above and below them. Per-day content is Markdown, keyed
// by date, in the note body: {"days":{"2026-07-14":"…markdown…"}}.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Editor } from '@tiptap/core';
import { NotebookEditor } from '../editor/NotebookEditor';
import { notebookExtensions } from '../editor/extensions';
import { eventHtml } from '../editor/event';

interface CalApi {
  getBody: (id: string) => Promise<string | null>;
  updateBody: (id: string, body: string) => Promise<void>;
}
function api(): CalApi { return (window as unknown as { notebookAPI: CalApi }).notebookAPI; }

// Data layer (day-page.ts): the day Markdown, its events, and the pure logic over them. This file
// is the views on top of it.
import {
  MONTHS, DOW, iso, fromIso, addDays, weekStart, parseDays, serializeDays, eventsOf, replaceEventAt,
  removeEventAt, appendEvent, hhmm, toMin, fmtTime, layoutDay, weeklyDates, DEFAULT_MIN, MIN_BLOCK,
  type CalEvent, type Days,
} from './day-page';
type View = 'month' | 'week' | 'day';

export default function CalendarDoc({ noteId }: { noteId: string }) {
  const today = useMemo(() => new Date(), []);
  const [days, setDays] = useState<Days>({});
  const [view, setView] = useState<View>('month');
  const [cursor, setCursor] = useState(() => new Date(today.getFullYear(), today.getMonth(), today.getDate()));
  const hydrated = useRef(false);

  useEffect(() => {
    let alive = true;
    hydrated.current = false;
    api().getBody(noteId).then((b) => { if (alive) { setDays(parseDays(b)); hydrated.current = true; } });
    return () => { alive = false; };
  }, [noteId]);

  useEffect(() => {
    if (!hydrated.current) return;
    api().updateBody(noteId, serializeDays(days)).catch(() => {});
  }, [days, noteId]);

  // Undo history for the week grid's edits. Snapshots are whole `days` maps — shallow copies of a
  // handful of strings, so cheap to keep. The day page doesn't use this: it's a ProseMirror editor
  // with its own ⌘Z, and two histories fighting over one keystroke would be worse than none.
  const history = useRef<{ past: Days[]; future: Days[] }>({ past: [], future: [] });
  const HISTORY_MAX = 50;
  // Snapshot outside the state updater, not inside: React may invoke an updater more than once, and
  // a push from in there would record the same edit twice.
  const mutate = (fn: (prev: Days) => Days) => {
    const next = fn(days);
    if (next === days) return;
    history.current.past.push(days);
    if (history.current.past.length > HISTORY_MAX) history.current.past.shift();
    history.current.future = [];
    setDays(next);
  };
  const undo = useCallback(() => {
    setDays((cur) => {
      const prev = history.current.past.pop();
      if (!prev) return cur;
      history.current.future.push(cur);
      return prev;
    });
  }, []);
  const redo = useCallback(() => {
    setDays((cur) => {
      const next = history.current.future.pop();
      if (!next) return cur;
      history.current.past.push(cur);
      return next;
    });
  }, []);

  const setDay = (date: string, md: string) => setDays((d) => ({ ...d, [date]: md }));
  // useCallback so the memoized WeekBlocks can skip re-rendering while a drag re-renders the grid.
  const hasContent = useCallback((date: string) => !!(days[date] && days[date].trim()), [days]);

  // Parsing a day re-runs DOMParser over its Markdown, and the grid asks for the same days several
  // times per render — and once per scroll frame, for the off-screen event markers. Cache on the
  // Markdown itself, so an edit misses the cache without any invalidation to get wrong.
  const parsed = useRef(new Map<string, CalEvent[]>());
  const eventsFor = useCallback((date: string) => {
    const md = days[date] || '';
    let hit = parsed.current.get(md);
    if (!hit) {
      if (parsed.current.size > 300) parsed.current.clear(); // ponytail: crude cap, it's only a cache
      hit = eventsOf(md);
      parsed.current.set(md, hit);
    }
    return hit;
  }, [days]);
  const openDay = useCallback((date: string) => { setCursor(fromIso(date)); setView('day'); }, []);

  // Drag/resize commit. Same day → rewrite the tag in place; a different day → move the tag across,
  // so the event stays a single node in exactly one day page rather than being copied.
  const moveEvent = (from: string, idx: number, to: string, start: string, end: string) => {
    mutate((prev) => {
      const ev = eventsOf(prev[from] || '')[idx];
      if (!ev) return prev;
      const moved = { ...ev, start, end };
      if (from === to) return { ...prev, [from]: replaceEventAt(prev[from] || '', idx, moved) };
      return { ...prev, [from]: removeEventAt(prev[from] || '', idx), [to]: appendEvent(prev[to] || '', moved) };
    });
  };

  const pasteEvent = (date: string, ev: CalEvent) => {
    mutate((prev) => ({ ...prev, [date]: appendEvent(prev[date] || '', ev) }));
  };

  // Copy `md` onto the same weekday of each following week, from the day AFTER `fromDate` up to
  // and including `untilDate` (appended below whatever is already there). Returns how many days.
  const repeatWeekly = (md: string, fromDate: string, untilDate: string): number => {
    const targets = weeklyDates(fromDate, untilDate);
    setDays((prev) => {
      const next = { ...prev };
      for (const k of targets) next[k] = (next[k] && next[k].trim() ? next[k].trimEnd() + '\n\n' : '') + md;
      return next;
    });
    return targets.length;
  };

  // The tick matters: scroll away but stay inside today's month and `cursor` never changes, so the
  // views' re-anchor effect wouldn't fire and Today would do nothing. Bumping it every click gives
  // them something to react to either way.
  const [todayTick, setTodayTick] = useState(0);
  const goToday = () => {
    setCursor(new Date(today.getFullYear(), today.getMonth(), today.getDate()));
    setTodayTick((t) => t + 1);
  };

  // Month and week both navigate by scrolling, so the title follows what's actually on screen
  // (reported by the view) rather than the cursor, which only marks where the scroll was anchored.
  const [scrolledTo, setScrolledTo] = useState<Date | null>(null);
  const titleDate = view === 'day' ? cursor : scrolledTo ?? cursor;

  // Events only exist inside a day page's editor, so ＋ opens the day you're looking at and hands
  // the insert to DayPage once its editor has mounted.
  const [pendingAdd, setPendingAdd] = useState(false);
  // Trackpad swipe on the day view: a dominant horizontal wheel gesture flips the day (swipe left
  // → next day, right → previous). swipeLock caps it at one day per gesture (momentum fires many
  // events); vertical scroll (deltaY dominant) falls through so the hour grid still scrolls.
  const swipeLock = useRef(0);
  const onDayWheel = (e: React.WheelEvent) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) || Math.abs(e.deltaX) < 40) return;
    const now = Date.now();
    if (now < swipeLock.current) return;
    swipeLock.current = now + 500;
    setCursor((c) => addDays(c, e.deltaX > 0 ? 1 : -1));
  };
  const addEvent = () => {
    setCursor(titleDate);
    setView('day');
    setPendingAdd(true);
  };

  return (
    <div className="cal">
      {/* One bar for all three views: month + year left, view picker and Today right. Day view adds
          which day, since nothing else on the page says it. */}
      <div className="cal-bar">
        <div className="cal-title">
          <b>{MONTHS[titleDate.getMonth()]}</b> {titleDate.getFullYear()}
          {view === 'day' && <span className="cal-title-day">{DOW[cursor.getDay()]} {cursor.getDate()}</span>}
        </div>
        <div className="cal-spacer" />
        <button className="cal-today" onClick={goToday}>Today</button>
        <div className="cal-views">
          {(['month', 'week', 'day'] as View[]).map((v) => (
            <button key={v} className={`cal-view-btn${view === v ? ' on' : ''}`} onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>
          ))}
        </div>
        <button className="cal-add" onClick={addEvent} title="Add event">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
        </button>
      </div>

      {view === 'month' && <MonthView cursor={cursor} today={today} has={hasContent} events={eventsFor} onDay={openDay} onVisible={setScrolledTo} todayTick={todayTick} onUndo={undo} onRedo={redo} />}
      {view === 'week' && <WeekView cursor={cursor} today={today} has={hasContent} events={eventsFor} onDay={openDay} onVisible={setScrolledTo} todayTick={todayTick} onMove={moveEvent} onPaste={pasteEvent} onUndo={undo} onRedo={redo} />}
      {view === 'day' && (
        <div className="cal-day-swipe" onWheel={onDayWheel}>
          <DayPage
            key={iso(cursor)} date={iso(cursor)} markdown={days[iso(cursor)] || ''}
            onChange={(md) => setDay(iso(cursor), md)}
            onRepeat={(md, until) => repeatWeekly(md, iso(cursor), until)}
            addOnOpen={pendingAdd} onAdded={() => setPendingAdd(false)}
          />
        </div>
      )}
    </div>
  );
}

const ROW_H = 92;                        // px per week row
const WEEKS_BACK = 26, WEEKS_FWD = 26;   // ponytail: ~6 months of scroll each way, no virtualisation.
                                         // Today re-anchors; wire up windowing only if that bites.
const MONTH_ROWS = 2;                    // events listed per month cell before "+N more"

// One event as a row in a month cell: a bar in its colour + the title, like Apple's month grid.
function MonthRow({ ev }: { ev: CalEvent }) {
  return (
    <div className="cal-mev" style={{ ['--ev-color' as string]: ev.color }} title={ev.title || 'Untitled event'}>
      <span className="cal-mev-bar" />
      <span className="cal-mev-title">{ev.title || 'Untitled'}</span>
    </div>
  );
}

// A continuous grid: half a year of weeks either side of the cursor's month, scrolling freely
// between them. No prev/next — scrolling is the navigation, and the month you've scrolled to is
// reported up for the title (and used to dim the neighbouring months' days).
function MonthView({ cursor, today, has, events, onDay, onVisible, todayTick, onUndo, onRedo }: {
  cursor: Date; today: Date; has: (d: string) => boolean; events: (d: string) => CalEvent[];
  onDay: (d: string) => void; onVisible: (d: Date) => void; todayTick: number;
  onUndo: () => void; onRedo: () => void;
}) {
  const year = cursor.getFullYear(), month = cursor.getMonth();
  const body = useRef<HTMLDivElement>(null);
  const [vis, setVis] = useState({ y: year, m: month });
  const grid = useMemo(() => {
    const start = addDays(weekStart(new Date(year, month, 1)), -WEEKS_BACK * 7);
    return Array.from({ length: (WEEKS_BACK + WEEKS_FWD) * 7 }, (_, i) => addDays(start, i));
  }, [year, month]);

  // A new anchor month rebuilds the grid under us, so land on it outright — there's nothing to
  // glide across. The month sits WEEKS_BACK rows down, past the weeks rendered behind it.
  useEffect(() => {
    setVis({ y: year, m: month });
    if (body.current) body.current.scrollTop = WEEKS_BACK * ROW_H;
  }, [year, month]);
  // Today when the grid is already anchored on today's month: same content, so glide back to it.
  useEffect(() => {
    if (todayTick) body.current?.scrollTo({ top: WEEKS_BACK * ROW_H, behavior: 'smooth' });
  }, [todayTick]);
  useEffect(() => { onVisible(new Date(vis.y, vis.m, 1)); }, [vis, onVisible]);

  // Whichever month owns the middle of the viewport is the month you're looking at.
  const onScroll = () => {
    const el = body.current;
    if (!el) return;
    const d = grid[Math.floor((el.scrollTop + el.clientHeight / 2) / ROW_H) * 7 + 3]; // midweek
    if (d && (d.getMonth() !== vis.m || d.getFullYear() !== vis.y)) setVis({ y: d.getFullYear(), m: d.getMonth() });
  };

  // Undo reaches here too: month has no editor of its own to fight over ⌘Z, so it can drive the
  // calendar's history directly — an edit made in week view is undoable from here.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.shiftKey ? onRedo() : onUndo();
      e.preventDefault();
    }
  };

  return (
    <>
      <div className="cal-dow">{DOW.map((d) => <div key={d} className="cal-dow-cell">{d}</div>)}</div>
      <div className="cal-month-body" ref={body} tabIndex={0} onScroll={onScroll} onKeyDown={onKeyDown}>
        <div className="cal-grid" style={{ ['--cal-row-h' as string]: `${ROW_H}px` }}>
          {grid.map((d) => {
            const key = iso(d);
            const evs = events(key);
            const first = d.getDate() === 1;
            const out = d.getMonth() !== vis.m || d.getFullYear() !== vis.y;
            return (
              <div key={key} className={`cal-cell${out ? ' out' : ''}${key === iso(today) ? ' today' : ''}`} onClick={() => onDay(key)}>
                <div className="cal-daynum">
                  {!evs.length && has(key) && <span className="cal-hasnote" />}
                  {/* The 1st carries its month name — the only marker once you've scrolled past a boundary. */}
                  {first ? `${MONTHS[d.getMonth()].slice(0, 3)} 1` : d.getDate()}
                </div>
                <div className="cal-mevs">
                  {evs.slice(0, MONTH_ROWS).map((e, i) => <MonthRow key={i} ev={e} />)}
                  {evs.length > MONTH_ROWS && <div className="cal-more">+{evs.length - MONTH_ROWS} more</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

const HOUR_H = 44;  // px per hour row; also fed to CSS as --cal-hour-h so the two can't drift
const GUTTER_W = 54; // px, must match --cal-gutter in the stylesheet
const GRID_TOP = 54; // px, must match --cal-head-h + --cal-allday-h: how far down a block its columns start
const SNAP = 15;     // minutes a drag snaps to
const DAY_MIN = 24 * 60;
const PEEK_H = 8;    // px, the off-screen-events marker strip; must match .cal-peek's height
const HOURS = Array.from({ length: 24 }, (_, h) => h);

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi));
const snap = (min: number) => Math.round(min / SNAP) * SNAP;
// Whole days between two dates — via the date parts, so a DST shift can't round to the wrong day.
const dayIndex = (from: Date, date: string) => Math.round((fromIso(date).getTime() - from.getTime()) / 864e5);

// A drag in flight. Held in a ref: pointermove must read it without a stale closure, and re-rendering
// the grid on every move would stutter. Only the ghost is state.
interface Drag { kind: 'move' | 'resize'; date: string; idx: number; ev: CalEvent; startMin: number; endMin: number; grabMin: number; moved: boolean }
interface Ghost { date: string; startMin: number; endMin: number; color: string }

// One week: sticky day header, all-day strip, and the 7 time columns. Rendered many times side by
// side inside the week scroller — vertical is time of day, horizontal walks the weeks.
//
// memo'd, and deliberately given no drag/selection props: dragging re-renders WeekView on every
// pointermove, and ~52 of these reconciling at 60fps would stutter. The drag ghost is drawn by
// WeekView instead, and the selected event is marked via a `sel` string that's identical for every
// block that doesn't own it. All handlers are delegated from the scroller, so blocks stay inert —
// they only publish which event each box is via data-date/data-idx.
const WeekBlock = React.memo(function WeekBlock({ start, today, has, events, sel }: {
  start: Date; today: Date; has: (d: string) => boolean; events: (d: string) => CalEvent[]; sel: string;
}) {
  const week = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return (
    <div className="cal-wblock">
      <div className="cal-wblock-head">
        {week.map((d) => {
          const key = iso(d);
          return (
            <div key={key} className={`cal-whead${key === iso(today) ? ' today' : ''}`} data-day={key}>
              {DOW[d.getDay()]} <span className="cal-wnum">{d.getDate()}</span>
              {!events(key).length && has(key) && <span className="cal-hasnote" />}
            </div>
          );
        })}
      </div>

      <div className="cal-wblock-allday">
        {week.map((d) => (
          <div key={iso(d)} className="cal-allday-cell" data-day={iso(d)}>
            {events(iso(d)).filter((e) => toMin(e.start) === null).map((e, j) => (
              <div key={j} className="cal-ev cal-ev--chip" style={{ ['--ev-color' as string]: e.color }} title={e.title || 'Untitled event'}>
                <span className="cal-ev-title">{e.title || 'Untitled'}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="cal-wblock-body">
        {week.map((d) => (
          <div key={iso(d)} className={`cal-wcol${iso(d) === iso(today) ? ' today' : ''}`} data-day={iso(d)}>
            {/* Drag the box to move it, its bottom edge to resize. Click the column to open the day. */}
            {layoutDay(events(iso(d))).map((p) => (
              <div
                key={p.idx} className={`cal-ev${sel === `${iso(d)}#${p.idx}` ? ' sel' : ''}`}
                data-date={iso(d)} data-idx={p.idx}
                style={{
                  ['--ev-color' as string]: p.ev.color,
                  top: (p.startMin / 60) * HOUR_H,
                  height: (Math.max(p.endMin - p.startMin, MIN_BLOCK) / 60) * HOUR_H,
                  left: `${(p.lane / p.lanes) * 100}%`,
                  width: `${100 / p.lanes}%`,
                }}
                title={`${p.ev.title || 'Untitled event'} · ${fmtTime(p.ev.start)}${p.ev.end ? `–${fmtTime(p.ev.end)}` : ''}`}
              >
                <span className="cal-ev-main">
                  <span className="cal-ev-title">{p.ev.title || 'Untitled'}</span>
                  <span className="cal-ev-time">{fmtTime(p.ev.start)}{p.ev.end && `–${fmtTime(p.ev.end)}`}</span>
                </span>
                <span className="cal-ev-grip" data-grip />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
});

/**
 * The week grid. Vertical scroll is time of day; horizontal scroll walks the weeks, snapping one
 * week at a time — that's the navigation, so there are no prev/next arrows. The hour gutter sticks
 * to the left and each block's header to the top, so both survive either axis.
 *
 *   ┌────┬─────────────┬─────────────┐
 *   │    │ Sun … Sat   │ Sun … Sat   │  ← blocks, each exactly one scrollport wide
 *   │ 9  ├─────────────┼─────────────┤
 *   │ 10 │   events    │   events    │
 *   └────┴─────────────┴─────────────┘
 *    ↑ sticky gutter    → scroll snaps here
 */
function WeekView({ cursor, today, has, events, onDay, onVisible, todayTick, onMove, onPaste, onUndo, onRedo }: {
  cursor: Date; today: Date; has: (d: string) => boolean; events: (d: string) => CalEvent[];
  onDay: (d: string) => void; onVisible: (d: Date) => void; todayTick: number;
  onMove: (from: string, idx: number, to: string, start: string, end: string) => void;
  onPaste: (date: string, ev: CalEvent) => void; onUndo: () => void; onRedo: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const anchorKey = iso(weekStart(cursor));
  // Day 0 of the rendered range — the scroll snaps per day, so positions are counted in days.
  const rangeStart = useMemo(() => addDays(fromIso(anchorKey), -WEEKS_BACK * 7), [anchorKey]);
  const [visDay, setVisDay] = useState(WEEKS_BACK * 7);
  const weeks = useMemo(
    () => Array.from({ length: WEEKS_BACK + WEEKS_FWD }, (_, i) => addDays(rangeStart, i * 7)),
    [rangeStart],
  );

  // Open on the anchor week's first event (an hour of air above it), else 8am — 24 hours of grid is
  // mostly empty and nobody wants to scroll to their own morning. Anchor changes only via Today /
  // opening the view; re-running on every edit would yank the scroll out from under the user.
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const firstMin = Math.min(...Array.from({ length: 7 }, (_, i) => layoutDay(events(iso(addDays(fromIso(anchorKey), i)))).map((p) => p.startMin)).flat(), 8 * 60);
    el.scrollTop = Math.max(0, (firstMin / 60 - 1) * HOUR_H);
    el.scrollLeft = WEEKS_BACK * (el.clientWidth - GUTTER_W);
    setVisDay(WEEKS_BACK * 7);
    readVp(el); // markers need a viewport before the first scroll, not after it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorKey]);

  // Today with this week already anchored: same columns, so glide sideways back to them. Vertical is
  // left alone — you asked for today's week, not to lose the time of day you were looking at.
  useEffect(() => {
    const el = body.current;
    if (todayTick && el) el.scrollTo({ left: WEEKS_BACK * (el.clientWidth - GUTTER_W), behavior: 'smooth' });
  }, [todayTick]);

  // Name the month of the middle day on screen — the scroll can rest mid-week, so a week's worth of
  // days can straddle two months and the title should follow the bulk of them.
  useEffect(() => { onVisible(addDays(rangeStart, visDay + 3)); }, [visDay, rangeStart, onVisible]);

  // Viewport, tracked so the off-screen event markers can follow the scroll. Blocks are memo'd, so
  // a scroll only re-renders the gutter and the markers themselves.
  const [vp, setVp] = useState({ top: 0, left: 0, h: 0 });
  const readVp = (el: HTMLDivElement) => setVp({ top: el.scrollTop, left: el.scrollLeft, h: el.clientHeight });

  const onScroll = () => {
    const el = body.current;
    if (!el) return;
    const d = Math.round(el.scrollLeft / Math.max(1, (el.clientWidth - GUTTER_W) / 7));
    if (d !== visDay) setVisDay(d);
    readVp(el);
  };

  // Which days have events out of sight, above or below the hours on screen. Only the ~8 columns in
  // view are worth asking about.
  const colW = body.current ? (body.current.clientWidth - GUTTER_W) / 7 : 0;
  const peeks: Array<{ key: string; side: string; left: number; top: number; colors: string[] }> = [];
  if (colW > 0 && vp.h > 0) {
    // The sticky header covers the top GRID_TOP px of the viewport, so the first hour you can
    // actually see starts level with it — which makes the visible range start exactly at scrollTop.
    const from = (vp.top / HOUR_H) * 60;
    const to = ((vp.top + vp.h - GRID_TOP) / HOUR_H) * 60;
    const firstCol = Math.max(0, Math.floor(vp.left / colW));
    for (let d = firstCol; d < Math.min(firstCol + 8, (WEEKS_BACK + WEEKS_FWD) * 7); d++) {
      const placed = layoutDay(events(iso(addDays(rangeStart, d))));
      if (!placed.length) continue;
      const above = placed.filter((p) => p.endMin <= from).map((p) => p.ev.color);
      const below = placed.filter((p) => p.startMin >= to).map((p) => p.ev.color);
      const left = GUTTER_W + d * colW;
      if (above.length) peeks.push({ key: `u${d}`, side: 'up', left, top: vp.top + GRID_TOP, colors: above });
      if (below.length) peeks.push({ key: `d${d}`, side: 'dn', left, top: vp.top + vp.h - PEEK_H, colors: below });
    }
  }

  // ── Drag / resize / clipboard ────────────────────────────────────────────────────────────
  const [sel, setSel] = useState('');                      // "date#idx" of the selected event
  const [ghost, setGhost] = useState<Ghost | null>(null);  // live preview while dragging
  const drag = useRef<Drag | null>(null);
  const clip = useRef<CalEvent | null>(null);
  const hover = useRef<{ date: string; min: number } | null>(null); // paste lands where you point
  const swallowClick = useRef(false);

  // Pointer → which day column and what time, in the scroller's own content coordinates.
  const at = (clientX: number, clientY: number) => {
    const el = body.current!;
    const r = el.getBoundingClientRect();
    const colW = (el.clientWidth - GUTTER_W) / 7;
    const day = Math.floor((clientX - r.left + el.scrollLeft - GUTTER_W) / colW);
    const min = ((clientY - r.top + el.scrollTop - GRID_TOP) / HOUR_H) * 60;
    return { date: iso(addDays(rangeStart, clamp(day, 0, (WEEKS_BACK + WEEKS_FWD) * 7 - 1))), min };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const box = (e.target as HTMLElement).closest('.cal-ev') as HTMLElement | null;
    if (!box?.dataset.date) return; // a column, or an all-day chip (no time axis to drag against)
    const date = box.dataset.date, idx = Number(box.dataset.idx);
    const ev = events(date)[idx];
    if (!ev) return;
    const startMin = toMin(ev.start) ?? 0;
    const rawEnd = toMin(ev.end);
    const endMin = rawEnd !== null && rawEnd > startMin ? rawEnd : startMin + DEFAULT_MIN;
    const kind = (e.target as HTMLElement).hasAttribute('data-grip') ? 'resize' : 'move';
    drag.current = { kind, date, idx, ev, startMin, endMin, grabMin: at(e.clientX, e.clientY).min - startMin, moved: false };
    setSel(`${date}#${idx}`);
    body.current?.setPointerCapture(e.pointerId);
    e.preventDefault();                              // no text selection / native drag mid-drag…
    body.current?.focus({ preventScroll: true });    // …but preventDefault also kills focus, and
                                                     // ⌘C/⌘V are handled here, so take it back.
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = at(e.clientX, e.clientY);
    hover.current = p;
    const d = drag.current;
    if (!d) return;
    d.moved = true;
    if (d.kind === 'move') {
      const dur = d.endMin - d.startMin;
      const start = clamp(snap(p.min - d.grabMin), 0, DAY_MIN - dur);
      setGhost({ date: p.date, startMin: start, endMin: start + dur, color: d.ev.color });
    } else {
      // Resize only ever changes the end, and never above a legible minimum.
      setGhost({ date: d.date, startMin: d.startMin, endMin: clamp(snap(p.min), d.startMin + SNAP, DAY_MIN), color: d.ev.color });
    }
  };

  const onPointerUp = () => {
    const d = drag.current, g = ghost;
    drag.current = null;
    setGhost(null);
    // A press that never moved is just a selection — don't rewrite the file for it.
    if (d?.moved && g) {
      onMove(d.date, d.idx, g.date, hhmm(g.startMin), hhmm(g.endMin));
      swallowClick.current = true; // a drag ends in a click too; it must not also open the day page
    }
  };

  // One delegated click for the whole grid. Clicking empty space in a day opens its page; clicking
  // an event only selects it (handled on pointerdown). Doing this here rather than with an onClick
  // per column keeps the two from fighting: an event box sits inside a column, so a per-column
  // handler would fire for clicks on events and at the end of every drag.
  const onClick = (e: React.MouseEvent) => {
    if (swallowClick.current) { swallowClick.current = false; return; }
    const t = e.target as HTMLElement;
    if (t.closest('.cal-ev')) return;
    const day = t.closest('[data-day]') as HTMLElement | null;
    if (day?.dataset.day) onDay(day.dataset.day);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const [date, i] = sel.split('#');
    if (e.key === 'z') {
      e.shiftKey ? onRedo() : onUndo();
      e.preventDefault();
    } else if (e.key === 'c' && sel) {
      clip.current = events(date)?.[Number(i)] ?? null;
      if (clip.current) e.preventDefault();
    } else if (e.key === 'v' && clip.current) {
      const ev = clip.current;
      const start = toMin(ev.start) ?? 0;
      const end = toMin(ev.end);
      const dur = end !== null && end > start ? end - start : DEFAULT_MIN;
      // Paste where you're pointing; falling back to the copy's own time on the selected day.
      const to = hover.current ?? (sel ? { date, min: start } : null);
      if (!to) return;
      const s = clamp(snap(to.min), 0, DAY_MIN - dur);
      onPaste(to.date, { ...ev, start: hhmm(s), end: hhmm(s + dur) });
      e.preventDefault();
    }
  };

  return (
    <div className="cal-week" style={{ ['--cal-hour-h' as string]: `${HOUR_H}px` }}>
      {/* tabIndex so ⌘C/⌘V land here: clicking an event focuses the scroller, and no editor is
          mounted in week view to compete for the keystrokes. */}
      <div
        className={`cal-week-body${ghost ? ' dragging' : ''}`} ref={body} tabIndex={0}
        onScroll={onScroll} onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onKeyDown={onKeyDown} onClick={onClick}
      >
        <div className="cal-gutter">
          <div className="cal-gutter-head">all-day</div>
          {HOURS.map((h) => <div key={h} className="cal-hour-lbl">{h === 12 ? 'Noon' : fmtTime(`${String(h).padStart(2, '0')}:00`)}</div>)}
        </div>
        {weeks.map((w) => <WeekBlock key={iso(w)} start={w} today={today} has={has} events={events} sel={sel} />)}
        {/* A tick per event you'd have to scroll to reach, in that event's own colour. */}
        {peeks.map((p) => (
          <div key={p.key} className={`cal-peek cal-peek--${p.side}`} style={{ left: p.left, width: colW, top: p.top }}
            title={`${p.colors.length} more event${p.colors.length > 1 ? 's' : ''} ${p.side === 'up' ? 'earlier' : 'later'}`}>
            {p.colors.slice(0, 6).map((c, i) => <span key={i} style={{ background: c }} />)}
          </div>
        ))}
        {ghost && body.current && (
          <div
            className="cal-ev cal-ev--ghost"
            style={{
              ['--ev-color' as string]: ghost.color,
              left: GUTTER_W + dayIndex(rangeStart, ghost.date) * ((body.current.clientWidth - GUTTER_W) / 7),
              width: (body.current.clientWidth - GUTTER_W) / 7,
              top: GRID_TOP + (ghost.startMin / 60) * HOUR_H,
              height: (Math.max(ghost.endMin - ghost.startMin, MIN_BLOCK) / 60) * HOUR_H,
            }}
          >
            <span className="cal-ev-main"><span className="cal-ev-time">{fmtTime(hhmm(ghost.startMin))}–{fmtTime(hhmm(ghost.endMin))}</span></span>
          </div>
        )}
      </div>
    </div>
  );
}

// Serialize the current selection (snapped to whole top-level blocks) to Markdown, so it can be
// repeated onto other days. Uses a throwaway editor because @tiptap/markdown serializes an editor.
function selectionMarkdown(editor: Editor): string {
  const { doc, selection } = editor.state;
  // Snap to whole top-level blocks so event boxes (atoms) and full paragraphs come along. A node
  // selection (clicking one event) sits at depth 0, so guard before()/after() which need depth≥1.
  const { $from, $to } = selection;
  const a = $from.depth ? $from.before(1) : $from.pos;
  const b = $to.depth ? $to.after(1) : $to.pos;
  const slice = doc.slice(a, b);
  const tmp = new Editor({ extensions: notebookExtensions(), content: { type: 'doc', content: slice.content.toJSON() ?? [] } });
  const md = (tmp as unknown as { getMarkdown: () => string }).getMarkdown().trimEnd();
  tmp.destroy();
  return md;
}

// A single day as a free-form editor + a toolbar for dropping in event / to-do containers and
// repeating a selection weekly.
function DayPage({ date, markdown, onChange, onRepeat, addOnOpen, onAdded }: {
  date: string; markdown: string; onChange: (md: string) => void; onRepeat: (md: string, until: string) => number;
  addOnOpen: boolean; onAdded: () => void;
}) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const [repeatOpen, setRepeatOpen] = useState(false);
  const repeatRef = useRef<HTMLDivElement>(null);
  const [until, setUntil] = useState('');
  const [msg, setMsg] = useState('');
  const [hasSel, setHasSel] = useState(false); // is there a non-empty selection to repeat?
  const weekday = DOW[fromIso(date).getDay()];

  // Click away (or Esc) to dismiss — the button was the only way out, which reads as a stuck dialog.
  useEffect(() => {
    if (!repeatOpen) return;
    const onDown = (e: MouseEvent) => { if (!repeatRef.current?.contains(e.target as Node)) setRepeatOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setRepeatOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [repeatOpen]);

  // Track whether something is selected/highlighted so Repeat is only enabled when it can act.
  useEffect(() => {
    if (!editor) return;
    const update = () => setHasSel(!editor.state.selection.empty);
    update();
    editor.on('selectionUpdate', update);
    editor.on('transaction', update);
    return () => { editor.off('selectionUpdate', update); editor.off('transaction', update); };
  }, [editor]);

  // A new event lands on the next half hour and runs for an hour, rather than with empty time
  // fields — a sensible time you can edit beats no time at all. Kept clear of midnight so the hour
  // still fits in the day.
  const addEvent = () => {
    const now = new Date();
    const start = Math.min(Math.ceil((now.getHours() * 60 + now.getMinutes()) / 30) * 30, DAY_MIN - 60);
    editor?.chain().focus().insertCalendarEvent({ start: hhmm(start), end: hhmm(start + 60) }).run();
  };
  const addTodo = () => editor?.chain().focus().toggleTaskList().run();

  // Arrived here from the bar's ＋: drop the event in as soon as the editor exists (it's null on the
  // first render of a freshly-mounted page), then clear the request so it fires exactly once.
  useEffect(() => {
    if (!addOnOpen || !editor) return;
    addEvent();
    onAdded();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addOnOpen, editor]);
  const apply = () => {
    if (!editor || !until) return;
    const md = selectionMarkdown(editor);
    if (!md) { setMsg('Select something to repeat first.'); return; }
    const n = onRepeat(md, until);
    setMsg(n ? `Added to ${n} ${weekday}${n > 1 ? 's' : ''}.` : 'No dates before that day.');
  };

  return (
    <div className="cal-day">
      {/* Adding an event lives in the bar's ＋ now; these two stay, as symbols. */}
      <div className="cal-day-tools">
        <button className="cal-tool" onClick={addTodo} disabled={!editor} title="To-do list">To-do</button>
        <div className="cal-repeat" ref={repeatRef}>
          <button className="cal-tool" onClick={() => { setRepeatOpen((v) => !v); setMsg(''); }} disabled={!editor || !hasSel} title={hasSel ? 'Repeat the selection weekly' : 'Select text or events first'}>Repeat</button>
          {repeatOpen && (
            <div className="cal-repeat-pop" onMouseDown={(e) => e.stopPropagation()}>
              <div className="cal-repeat-label">Repeat the highlighted text/events every <b>{weekday}</b> until:</div>
              <div className="cal-repeat-row">
                <input type="date" className="cal-input" min={date} value={until} onChange={(e) => { setUntil(e.target.value); setMsg(''); }} />
                <button className="cal-save" disabled={!until} onClick={apply}>Repeat</button>
              </div>
              {msg && <div className="cal-repeat-msg">{msg}</div>}
            </div>
          )}
        </div>
      </div>
      <div className="cal-day-editor">
        <NotebookEditor
          key={date}
          noteId={`cal:${date}`}
          markdown={markdown}
          onChange={(_id, md) => onChange(md)}
          onEditorReady={setEditor}
        />
      </div>
    </div>
  );
}
