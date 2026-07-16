import { describe, it, expect } from 'vitest';
import { mentionsCalendar } from './calendar-intent';

describe('mentionsCalendar', () => {
  it('stays out of the way of a chat that has nothing to do with the calendar', () => {
    // The bug this gate exists for: "make a note" came back as a proposed calendar event.
    for (const text of [
      'hey make a note',
      'summarize my notes on graph theory',
      'what does this error mean?',
      'rewrite that paragraph to be shorter',
      'who won the 1998 world cup',
    ]) {
      expect(mentionsCalendar(text), text).toBe(false);
    }
  });

  it('arms on a calendar word, with no time named', () => {
    for (const text of [
      'add a dentist appointment',
      'clear my schedule',
      'what meetings do I have',
      "delete the lecture I'm not going to",
      'am I free',
    ]) {
      expect(mentionsCalendar(text), text).toBe(true);
    }
  });

  it('arms on a named time, with no calendar word', () => {
    for (const text of [
      'put gym at 6pm',
      'lunch with Sam tomorrow',
      'CSE 214 on 2026-07-20 09:30 to 12:45',
      'move it to next week',
      'block off Friday morning',
      'dinner at 7',
      'the 21st, all day',
    ]) {
      expect(mentionsCalendar(text), text).toBe(true);
    }
  });

  it('reads case-insensitively and inside a longer sentence', () => {
    expect(mentionsCalendar('Could you please add THAT to my Calendar for me')).toBe(true);
  });
});
