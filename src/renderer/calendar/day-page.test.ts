// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  weeklyDates, eventsOf, fmtTime, layoutDay, replaceEventAt, removeEventAt, appendEvent, hhmm,
  type CalEvent,
} from './day-page';

const ev = (title: string, start: string, end = ''): CalEvent => ({ title, start, end, color: '#3b82f6' });

describe('weeklyDates (repeat on the same weekday until a date)', () => {
  it('lists following same-weekday dates up to and including the end', () => {
    // 2026-07-14 is a Tuesday.
    expect(weeklyDates('2026-07-14', '2026-08-11')).toEqual(['2026-07-21', '2026-07-28', '2026-08-04', '2026-08-11']);
  });
  it('excludes the start day itself and stops at the end', () => {
    expect(weeklyDates('2026-07-14', '2026-07-20')).toEqual([]); // next Tue (21st) is past the 20th
    expect(weeklyDates('2026-07-14', '2026-07-21')).toEqual(['2026-07-21']);
  });
  it('crosses month/year boundaries correctly', () => {
    expect(weeklyDates('2026-12-29', '2027-01-19')).toEqual(['2027-01-05', '2027-01-12', '2027-01-19']);
  });
});

describe('eventsOf (month/week views read events back out of a day page)', () => {
  it('pulls out every event with its colour, ignoring surrounding Markdown', () => {
    const md = [
      'Some notes above.',
      '<div data-cal-event data-title="CSE 214 Lecture" data-start="09:30" data-end="12:45" data-color="#3b82f6"></div>',
      '- [ ] a todo',
      '<div data-cal-event data-title="Recitation" data-start="13:00" data-end="" data-color="#ef4444"></div>',
    ].join('\n\n');
    expect(eventsOf(md)).toEqual([
      { title: 'CSE 214 Lecture', start: '09:30', end: '12:45', color: '#3b82f6' },
      { title: 'Recitation', start: '13:00', end: '', color: '#ef4444' },
    ]);
  });
  it('reads the legacy data-time attr as the start', () => {
    expect(eventsOf('<div data-cal-event data-title="Old" data-time="08:00" data-color="#10b981"></div>')[0])
      .toMatchObject({ start: '08:00' });
  });
  it('falls back to the default colour rather than trusting a hand-edited one', () => {
    const bad = '<div data-cal-event data-title="x" data-color="url(evil)"></div>';
    expect(eventsOf(bad)[0].color).toBe('#3b82f6');
  });
  it('does not execute or keep markup from a hand-edited title', () => {
    const md = '<div data-cal-event data-title="&lt;img src=x onerror=boom&gt;" data-color="#3b82f6"></div>';
    expect(eventsOf(md)[0].title).toBe('<img src=x onerror=boom>'); // inert text, rendered as a React child
  });
  it('is empty for a day with no events', () => {
    expect(eventsOf('just notes')).toEqual([]);
    expect(eventsOf('')).toEqual([]);
  });
});

describe('fmtTime', () => {
  it('formats 24h day-page times for the week chips', () => {
    expect(fmtTime('09:30')).toBe('9:30am');
    expect(fmtTime('13:00')).toBe('1pm');
    expect(fmtTime('00:05')).toBe('12:05am');
    expect(fmtTime('12:00')).toBe('12pm');
    expect(fmtTime('')).toBe('');
    expect(fmtTime('25:00')).toBe('');
  });
});

describe('hhmm (minutes → what a day page stores)', () => {
  it('formats and clamps to a real time of day', () => {
    expect(hhmm(0)).toBe('00:00');
    expect(hhmm(570)).toBe('09:30');
    expect(hhmm(1439)).toBe('23:59');
    expect(hhmm(1440)).toBe('23:59'); // a drag to the very bottom must not write "24:00"
    expect(hhmm(-30)).toBe('00:00');
  });
  it('round-trips through the reader', () => {
    expect(fmtTime(hhmm(1440))).not.toBe(''); // ...which toMin would reject, showing no time at all
  });
});

// The week grid's drag/resize rewrites these tags in the user's day pages, so the surgery has to
// leave everything around it untouched — and hit the event the layout actually pointed at.
describe('day-page writers', () => {
  const ev = (t: string, s: string, e = '', c = '#3b82f6'): CalEvent => ({ title: t, start: s, end: e, color: c });
  const day = [
    'Morning notes.',
    '<div data-cal-event data-title="Lecture" data-start="09:30" data-end="12:45" data-color="#3b82f6"></div>',
    '- [ ] a todo',
    '<div data-cal-event data-title="Recitation" data-start="13:00" data-end="14:10" data-color="#ef4444"></div>',
    'Closing thought.',
  ].join('\n\n');

  it('replaces one event without disturbing the prose around it', () => {
    const out = replaceEventAt(day, 0, { ...ev('Lecture', '10:00', '13:15'), color: '#3b82f6' });
    expect(eventsOf(out)).toEqual([
      { title: 'Lecture', start: '10:00', end: '13:15', color: '#3b82f6' },
      { title: 'Recitation', start: '13:00', end: '14:10', color: '#ef4444' },
    ]);
    expect(out).toContain('Morning notes.');
    expect(out).toContain('- [ ] a todo');
    expect(out).toContain('Closing thought.');
  });

  it('addresses the same event the reader reported, not the first tag it finds', () => {
    const out = replaceEventAt(day, 1, ev('Recitation', '15:00', '16:00', '#ef4444'));
    expect(eventsOf(out)[0].start).toBe('09:30'); // untouched
    expect(eventsOf(out)[1].start).toBe('15:00');
  });

  it('removes an event and closes up the gap it leaves', () => {
    const out = removeEventAt(day, 0);
    expect(eventsOf(out).map((e) => e.title)).toEqual(['Recitation']);
    expect(out).toContain('Morning notes.');
    expect(out).not.toMatch(/\n{3,}/);
  });

  it('appends to an empty day and to a day with content', () => {
    expect(eventsOf(appendEvent('', ev('New', '09:00')))).toHaveLength(1);
    const out = appendEvent('Just notes.', ev('New', '09:00'));
    expect(out.startsWith('Just notes.')).toBe(true);
    expect(eventsOf(out)).toEqual([{ title: 'New', start: '09:00', end: '', color: '#3b82f6' }]);
  });

  it('escapes a title on write, so a quote cannot break out of the attribute', () => {
    const out = appendEvent('', ev('He said "hi" <b>', '09:00'));
    expect(out).toContain('data-title="He said &quot;hi&quot; &lt;b&gt;"');
    expect(eventsOf(out)[0].title).toBe('He said "hi" <b>'); // and reads back intact
    expect(eventsOf(out)).toHaveLength(1);
  });

  it('is a no-op when the index does not exist, rather than corrupting the page', () => {
    expect(replaceEventAt(day, 9, ev('Nope', '01:00'))).toBe(day);
    expect(removeEventAt(day, 9)).toBe(day);
    expect(replaceEventAt('just notes', 0, ev('Nope', '01:00'))).toBe('just notes');
  });

  it('survives a move round-trip: read, rewrite, read back', () => {
    const moved = replaceEventAt(day, 0, { ...eventsOf(day)[0], start: hhmm(600), end: hhmm(795) });
    expect(eventsOf(moved)[0]).toEqual({ title: 'Lecture', start: '10:00', end: '13:15', color: '#3b82f6' });
  });
});

describe('layoutDay (week-grid placement)', () => {
  const at = (p: ReturnType<typeof layoutDay>[number]) => [p.ev.title, p.startMin, p.endMin, p.lane, p.lanes];

  it('places a timed event and gives an event with no end the default hour', () => {
    expect(layoutDay([ev('Lecture', '09:30', '12:45')]).map(at)).toEqual([['Lecture', 570, 765, 0, 1]]);
    expect(layoutDay([ev('Standup', '09:00')]).map(at)).toEqual([['Standup', 540, 600, 0, 1]]);
  });

  it('drops events with no usable start (those belong in the all-day strip)', () => {
    expect(layoutDay([ev('Someday', ''), ev('Junk', 'whenever')])).toEqual([]);
  });

  it('gives overlapping events their own lane and equal width', () => {
    const out = layoutDay([ev('A', '10:00', '11:45'), ev('B', '10:30', '12:00')]).map(at);
    expect(out).toEqual([['A', 600, 705, 0, 2], ['B', 630, 720, 1, 2]]);
  });

  it('returns to full width once a cluster ends', () => {
    const out = layoutDay([ev('A', '09:00', '10:00'), ev('B', '09:30', '10:30'), ev('C', '13:00', '14:10')]).map(at);
    expect(out).toEqual([['A', 540, 600, 0, 2], ['B', 570, 630, 1, 2], ['C', 780, 850, 0, 1]]);
  });

  it('reuses a lane once its event has ended, rather than widening the cluster', () => {
    // C starts after A ends but while B runs — it belongs in A's lane, so the cluster stays 2 wide.
    const out = layoutDay([ev('A', '09:00', '10:00'), ev('B', '09:30', '12:00'), ev('C', '10:00', '11:00')]).map(at);
    expect(out).toEqual([['A', 540, 600, 0, 2], ['B', 570, 720, 1, 2], ['C', 600, 660, 0, 2]]);
  });

  it('handles a back-to-back day with no overlap at all', () => {
    const out = layoutDay([ev('B', '10:00', '11:00'), ev('A', '09:00', '10:00')]).map(at);
    expect(out).toEqual([['A', 540, 600, 0, 1], ['B', 600, 660, 0, 1]]); // sorted, both full width
  });

  it('clamps an event that would run past midnight', () => {
    expect(layoutDay([ev('Late', '23:30')]).map(at)).toEqual([['Late', 1410, 1440, 0, 1]]);
  });

  it('treats an end at or before the start as an unset end', () => {
    expect(layoutDay([ev('Typo', '14:00', '13:00')]).map(at)).toEqual([['Typo', 840, 900, 0, 1]]);
  });

  it('reports each event\'s index in the day, not its sorted position', () => {
    // Laying out sorts by time; a drag uses idx to find the tag, so it must survive the sort and
    // the dropped all-day event — otherwise dragging one event rewrites another.
    const out = layoutDay([ev('Late', '15:00'), ev('AllDay', ''), ev('Early', '09:00')]);
    expect(out.map((p) => [p.ev.title, p.idx])).toEqual([['Early', 2], ['Late', 0]]);
  });
});
