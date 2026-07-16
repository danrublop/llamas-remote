// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseCalOps, stripCalOps, applyCalOps, describeOp } from './calendar-ops';
import { eventsOf } from './day-page';

const add = (extra = '') => `<<<CAL ADD>>>
date: 2026-07-20
title: CSE 214 Lecture
start: 09:30
end: 12:45
color: #ec4899
${extra}<<<END>>>`;

describe('parseCalOps', () => {
  it('reads an add block out of a reply', () => {
    expect(parseCalOps(`Sure, adding that.\n\n${add()}`)).toEqual([
      { kind: 'add', date: '2026-07-20', title: 'CSE 214 Lecture', start: '09:30', end: '12:45', color: '#ec4899' },
    ]);
  });

  it('reads move and delete, and defaults a move with no `to` to the same day', () => {
    const text = `<<<CAL MOVE>>>
date: 2026-07-20
match: CSE 214
start: 10:00
<<<END>>>
<<<CAL DELETE>>>
date: 2026-07-21
match: Recitation
<<<END>>>`;
    expect(parseCalOps(text)).toEqual([
      { kind: 'move', date: '2026-07-20', match: 'CSE 214', to: '2026-07-20', start: '10:00', end: '' },
      { kind: 'delete', date: '2026-07-21', match: 'Recitation' },
    ]);
  });

  it('drops a block with no date, rather than guessing one', () => {
    expect(parseCalOps('<<<CAL ADD>>>\ntitle: Nowhere\n<<<END>>>')).toEqual([]);
    expect(parseCalOps('<<<CAL ADD>>>\ndate: next tuesday\ntitle: x\n<<<END>>>')).toEqual([]);
  });

  it('drops an add with no title and a move/delete with nothing to match', () => {
    expect(parseCalOps('<<<CAL ADD>>>\ndate: 2026-07-20\n<<<END>>>')).toEqual([]);
    expect(parseCalOps('<<<CAL MOVE>>>\ndate: 2026-07-20\nto: 2026-07-21\n<<<END>>>')).toEqual([]);
  });

  it('refuses a colour that is not a plain hex value', () => {
    // The colour reaches a style attribute, so anything else falls back to the default.
    const op = parseCalOps(add().replace('#ec4899', 'url(javascript:alert(1))'))[0];
    expect(op).toMatchObject({ color: '#3b82f6' });
  });

  it('ignores junk times and an end before its start', () => {
    expect(parseCalOps(add().replace('start: 09:30', 'start: half nine'))[0]).toMatchObject({ start: '', end: '' });
    expect(parseCalOps(add().replace('end: 12:45', 'end: 08:00'))[0]).toMatchObject({ start: '09:30', end: '10:30' });
  });

  it('ignores unknown fields instead of failing the block', () => {
    expect(parseCalOps(add('priority: high\n'))[0]).toMatchObject({ title: 'CSE 214 Lecture' });
  });

  it('finds nothing in an ordinary reply', () => {
    expect(parseCalOps('Your Monday looks busy — three lectures back to back.')).toEqual([]);
  });
});

describe('stripCalOps', () => {
  it('leaves the prose and drops the blocks', () => {
    expect(stripCalOps(`Adding it now.\n\n${add()}\n\nAnything else?`)).toBe('Adding it now.\n\nAnything else?');
  });
});

describe('applyCalOps', () => {
  const days = {
    '2026-07-20': 'Morning notes.\n\n<div data-cal-event data-title="CSE 214 Lecture" data-start="09:30" data-end="12:45" data-color="#3b82f6"></div>',
  };

  it('adds an event to a day, keeping what was already on the page', () => {
    const r = applyCalOps(days, parseCalOps(add().replace('CSE 214 Lecture', 'Office hours')));
    expect(r).toMatchObject({ applied: 1, failed: 0 });
    expect(eventsOf(r.days['2026-07-20']).map((e) => e.title)).toEqual(['CSE 214 Lecture', 'Office hours']);
    expect(r.days['2026-07-20']).toContain('Morning notes.');
  });

  it('adds to a day that does not exist yet', () => {
    const r = applyCalOps({}, parseCalOps(add()));
    expect(eventsOf(r.days['2026-07-20'])).toHaveLength(1);
  });

  it('matches an event by a partial, case-insensitive title', () => {
    const r = applyCalOps(days, [{ kind: 'delete', date: '2026-07-20', match: 'cse 214' }]);
    expect(r).toMatchObject({ applied: 1, failed: 0 });
    expect(eventsOf(r.days['2026-07-20'])).toEqual([]);
    expect(r.days['2026-07-20']).toContain('Morning notes.'); // the prose survives
  });

  it('moves an event to another day, leaving it in exactly one place', () => {
    const r = applyCalOps(days, [{ kind: 'move', date: '2026-07-20', match: 'CSE 214', to: '2026-07-21', start: '', end: '' }]);
    expect(eventsOf(r.days['2026-07-20'])).toEqual([]);
    expect(eventsOf(r.days['2026-07-21'])).toEqual([
      { title: 'CSE 214 Lecture', start: '09:30', end: '12:45', color: '#3b82f6' }, // times kept
    ]);
  });

  it('retimes an event in place when the move names no other day', () => {
    const r = applyCalOps(days, parseCalOps('<<<CAL MOVE>>>\ndate: 2026-07-20\nmatch: CSE 214\nstart: 11:00\nend: 14:00\n<<<END>>>'));
    expect(eventsOf(r.days['2026-07-20'])[0]).toMatchObject({ start: '11:00', end: '14:00' });
  });

  it('counts an op that matches nothing as failed, and changes nothing', () => {
    const r = applyCalOps(days, [{ kind: 'delete', date: '2026-07-20', match: 'Yoga' }]);
    expect(r).toMatchObject({ applied: 0, failed: 1 });
    expect(r.days).toEqual(days);
  });

  it('does not mutate the days it was given', () => {
    const before = JSON.stringify(days);
    applyCalOps(days, parseCalOps(add()));
    expect(JSON.stringify(days)).toBe(before);
  });

  it('escapes a title on the way in, so a model reply cannot inject markup', () => {
    const r = applyCalOps({}, parseCalOps(add().replace('CSE 214 Lecture', '<img src=x onerror=boom>')));
    expect(r.days['2026-07-20']).toContain('&lt;img src=x onerror=boom&gt;');
    expect(eventsOf(r.days['2026-07-20'])[0].title).toBe('<img src=x onerror=boom>'); // inert text
  });
});

describe('describeOp', () => {
  it('says what each op will do', () => {
    expect(describeOp(parseCalOps(add())[0])).toBe('Add “CSE 214 Lecture” on 2026-07-20 at 09:30');
    expect(describeOp({ kind: 'delete', date: '2026-07-20', match: 'Yoga' })).toBe('Delete “Yoga” from 2026-07-20');
    expect(describeOp({ kind: 'move', date: '2026-07-20', match: 'Yoga', to: '2026-07-21', start: '08:00', end: '' }))
      .toBe('Move “Yoga” to 2026-07-21 at 08:00');
  });
});
