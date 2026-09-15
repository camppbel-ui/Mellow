'use strict';
/**
 * test-calendar.js - the iCalendar parser.
 *
 * Every case here is something a real export actually does: folded lines,
 * escaped commas, a weekly class with BYDAY, a cancelled lecture as an EXDATE,
 * all-day events, and UTC versus floating times.
 *
 *   node test-calendar.js
 */

const ics = require('./lib/ics');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

const FROM = new Date(2026, 8, 1);    // 1 Sep 2026
const TO   = new Date(2026, 11, 31);  // 31 Dec 2026

function cal(body) {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;
}

console.log('\nLine handling');
check('folded lines are rejoined',
  ics.unfold('SUMMARY:Intro to\r\n  Biology') === 'SUMMARY:Intro to Biology');
check('escaped commas come back',
  ics.unescapeText('Lab\\, room 4') === 'Lab, room 4');
check('parameters are split off the property name', (() => {
  const p = ics.parseLine('DTSTART;TZID=America/New_York:20260910T090000');
  return p.name === 'DTSTART' && p.params.TZID === 'America/New_York' && p.value === '20260910T090000';
})());
check('a value containing a colon survives', (() => {
  const p = ics.parseLine('LOCATION:Room 4: the annex');
  return p.value === 'Room 4: the annex';
})());

console.log('\nDates');
check('an all-day date has no time',
  ics.parseDate('20260910').allDay === true);
check('a UTC time is exact', (() => {
  const d = ics.parseDate('20260910T140000Z').date;
  return d.getUTCHours() === 14 && d.getUTCMinutes() === 0;
})());
check('a floating time is read as local', (() => {
  const d = ics.parseDate('20260910T090000').date;
  return d.getHours() === 9;
})());
check('nonsense returns null rather than an invalid date',
  ics.parseDate('not-a-date') === null);

console.log('\nA single event');
const one = ics.parseIcs(cal(
  'BEGIN:VEVENT\r\nUID:a1\r\nSUMMARY:Advising meeting\r\nLOCATION:Main 201\r\n' +
  'DTSTART:20260915T140000Z\r\nDTEND:20260915T150000Z\r\nEND:VEVENT'), FROM, TO);
check('one event is found', one.length === 1);
check('its title is read', one[0].title === 'Advising meeting');
check('its location is read', one[0].location === 'Main 201');
check('an event outside the window is excluded',
  ics.parseIcs(cal(
    'BEGIN:VEVENT\r\nUID:b\r\nSUMMARY:Last year\r\n' +
    'DTSTART:20250915T140000Z\r\nDTEND:20250915T150000Z\r\nEND:VEVENT'), FROM, TO).length === 0);
check('DTSTART with no DTEND still yields an event',
  ics.parseIcs(cal(
    'BEGIN:VEVENT\r\nUID:c\r\nSUMMARY:Reminder\r\nDTSTART:20260915T140000Z\r\nEND:VEVENT'),
    FROM, TO).length === 1);
check('a cancelled event is dropped',
  ics.parseIcs(cal(
    'BEGIN:VEVENT\r\nUID:d\r\nSUMMARY:Called off\r\nSTATUS:CANCELLED\r\n' +
    'DTSTART:20260915T140000Z\r\nDTEND:20260915T150000Z\r\nEND:VEVENT'), FROM, TO).length === 0);

console.log('\nA weekly class, which is the whole point');
// Mon/Wed/Fri 09:00, 1 Sep to 15 Dec. 1 Sep 2026 is a Tuesday.
const cls = cal(
  'BEGIN:VEVENT\r\nUID:bio101\r\nSUMMARY:BIO 101 Lecture\r\nLOCATION:Welch 2.224\r\n' +
  'DTSTART:20260902T090000\r\nDTEND:20260902T095000\r\n' +
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261215T050000Z\r\nEND:VEVENT');
const lectures = ics.parseIcs(cls, FROM, TO);
check('it repeats many times', lectures.length > 30);
check('every occurrence lands on Mon, Wed or Fri',
  lectures.every((e) => [1, 3, 5].includes(e.start.getDay())));
check('every occurrence keeps the 09:00 start',
  lectures.every((e) => e.start.getHours() === 9));
check('every occurrence keeps the 50 minute length',
  lectures.every((e) => (e.end - e.start) === 50 * 60000));
check('nothing is generated after UNTIL',
  lectures.every((e) => e.start < new Date(2026, 11, 16)));
check('they come back in order',
  lectures.every((e, i) => i === 0 || e.start >= lectures[i - 1].start));

console.log('\nA cancelled lecture');
const withEx = cal(
  'BEGIN:VEVENT\r\nUID:bio101\r\nSUMMARY:BIO 101 Lecture\r\n' +
  'DTSTART:20260902T090000\r\nDTEND:20260902T095000\r\n' +
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261215T050000Z\r\n' +
  'EXDATE:20260909T090000\r\nEND:VEVENT');
const trimmed = ics.parseIcs(withEx, FROM, TO);
check('the excluded date is gone',
  !trimmed.some((e) => e.start.getTime() === new Date(2026, 8, 9, 9, 0, 0).getTime()));
check('and only that one is gone',
  trimmed.length === lectures.length - 1);

console.log('\nOther recurrences');
check('a daily rule with INTERVAL skips days', (() => {
  const out = ics.parseIcs(cal(
    'BEGIN:VEVENT\r\nUID:e\r\nSUMMARY:Every other day\r\n' +
    'DTSTART:20260901T080000\r\nDTEND:20260901T081500\r\n' +
    'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=5\r\nEND:VEVENT'), FROM, TO);
  return out.length === 5 && (out[1].start - out[0].start) === 2 * 86400000;
})());
check('COUNT is respected', (() => {
  const out = ics.parseIcs(cal(
    'BEGIN:VEVENT\r\nUID:f\r\nSUMMARY:Three times\r\n' +
    'DTSTART:20260901T080000\r\nDTEND:20260901T081500\r\n' +
    'RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3\r\nEND:VEVENT'), FROM, TO);
  return out.length === 3;
})());
check('an unsupported frequency yields one occurrence, not wrong ones', (() => {
  const out = ics.parseIcs(cal(
    'BEGIN:VEVENT\r\nUID:g\r\nSUMMARY:Monthly thing\r\n' +
    'DTSTART:20260915T080000\r\nDTEND:20260915T090000\r\n' +
    'RRULE:FREQ=MONTHLY;BYMONTHDAY=15\r\nEND:VEVENT'), FROM, TO);
  return out.length === 1;
})());

console.log('\nAll-day events');
const allDay = ics.parseIcs(cal(
  'BEGIN:VEVENT\r\nUID:h\r\nSUMMARY:Reading day\r\n' +
  'DTSTART;VALUE=DATE:20260920\r\nDTEND;VALUE=DATE:20260921\r\nEND:VEVENT'), FROM, TO);
check('an all-day event is flagged', allDay.length === 1 && allDay[0].allDay === true);
check('it starts at midnight', allDay[0].start.getHours() === 0);

console.log('\nRobustness');
check('an empty document yields nothing, not an error',
  ics.parseIcs('', FROM, TO).length === 0);
check('junk yields nothing, not an error',
  ics.parseIcs('this is not a calendar at all', FROM, TO).length === 0);
check('an unterminated event does not produce a broken entry',
  ics.parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Truncated\r\n', FROM, TO).length === 0);
check('an event with no SUMMARY still has a title', (() => {
  const out = ics.parseIcs(cal(
    'BEGIN:VEVENT\r\nUID:i\r\nDTSTART:20260915T140000Z\r\nDTEND:20260915T150000Z\r\nEND:VEVENT'),
    FROM, TO);
  return out.length === 1 && out[0].title === '(no title)';
})());
check('two events in one file both come through',
  ics.parseIcs(cal(
    'BEGIN:VEVENT\r\nUID:j\r\nSUMMARY:One\r\nDTSTART:20260915T140000Z\r\nDTEND:20260915T150000Z\r\nEND:VEVENT\r\n' +
    'BEGIN:VEVENT\r\nUID:k\r\nSUMMARY:Two\r\nDTSTART:20260916T140000Z\r\nDTEND:20260916T150000Z\r\nEND:VEVENT'),
    FROM, TO).length === 2);

console.log('\nSource tagging');
check('events carry the calendar they came from', (() => {
  const out = ics.parseIcs(cal(
    'BEGIN:VEVENT\r\nUID:l\r\nSUMMARY:Seminar\r\nDTSTART:20260915T140000Z\r\nDTEND:20260915T150000Z\r\nEND:VEVENT'),
    FROM, TO, { id: 'school', name: 'School', color: '#2f5f8a' });
  return out[0].calendar === 'School' && out[0].calendarId === 'school' && out[0].color === '#2f5f8a';
})());

console.log(`\n${pass} passing, ${fail} failing\n`);
process.exit(fail === 0 ? 0 : 1);
