// Does this message plausibly concern the calendar?
//
// The calendar tool spec is only put in front of the model when this says yes. A small local model
// handed a tool spec on EVERY turn reaches for it whether or not it fits — "hey make a note" came
// back as a proposed calendar event, because the calendar was the only tool it had. Telling it
// "only emit blocks when asked" doesn't hold on a 7B; not showing it the format does.
//
// Deliberately generous. A false positive only ARMS the tools — the model still decides, and the
// user still clicks Apply before anything is written. A false negative silently disarms a real
// calendar request, which is the worse failure, so when in doubt this says yes.

/** Words that are about the calendar regardless of whether a time is named. */
const CAL_WORDS =
  /\b(calendars?|schedul\w*|reschedul\w*|events?|appointments?|meetings?|reminders?|remind|agenda|lectures?|classe?s?|deadlines?|birthdays?|holidays?|rsvp|booked?|booking|busy|free|available|my day|my week)\b/i;

/** A named time or date. On its own this is enough — "put gym at 6pm" names no calendar word. */
const TIME_WORDS =
  /\b(today|tonight|tomorrow|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|may|june|july|august|september|october|november|december|noon|midnight|next (week|month|year)|this (week|month|weekend)|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|\d{1,2}\s?[ap]\.?m\.?|at \d{1,2}\b|\d{1,2}(st|nd|rd|th)\b)/i;

/**
 * True if the calendar tools should be armed for this message.
 *
 * ponytail: gates on the user's message alone, so a bare follow-up ("actually make it 7") can miss
 * and get a prose reply instead of a revised block. Feed it the recent history too if that bites.
 */
export function mentionsCalendar(text: string): boolean {
  return CAL_WORDS.test(text) || TIME_WORDS.test(text);
}
