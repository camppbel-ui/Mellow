'use strict';
/**
 * test-engine.js - covers the deciding half.
 *
 * Every test pins the clock, because the whole point of the escalation ladder
 * is what it does at 3am on a Thursday and you cannot wait for that.
 *
 *   node test-engine.js
 */

const sched = require('./lib/schedule');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

/* Wednesday 2026-09-09, so weekday/weekend behaviour is unambiguous. */
const at = (iso) => new Date(iso);
const WED_2000 = at('2026-09-09T20:00:00');
const WED_2130 = at('2026-09-09T21:30:00');
const WED_2300 = at('2026-09-09T23:00:00');
const THU_0400 = at('2026-09-10T04:00:00');
const SAT = at('2026-09-12T20:00:00');

/* startedOn is pinned on every fixture. Without it a task's history begins
   whenever the test happens to run, and half of these would be testing the
   clock instead of the ladder. */
const readTask = {
  id: 'read',
  title: 'Read a book',
  clearedBy: 'Run the timer',
  startedOn: '2026-09-09',
  cadence: { type: 'daily', dueBy: '21:00' },
  escalation: [
    { afterMinutes: 0, level: 'nudge' },
    { afterMinutes: 45, level: 'persistent' },
    { afterMinutes: 90, level: 'shield_social', groups: ['distractions'] },
    { afterMinutes: 240, level: 'shield_all' },
  ],
};

const emailTask = {
  id: 'email',
  title: 'Clear flagged email',
  startedOn: '2026-09-09',
  cadence: { type: 'weekdays', dueBy: '17:00' },
  escalation: [
    { afterMinutes: 0, level: 'nudge' },
    { afterMinutes: 1440, level: 'shield_social', groups: ['games'] },
  ],
};

const empty = { records: [] };
const doneAt = (taskId, iso, kind = 'done') => ({ records: [{ taskId, kind, at: at(iso).toISOString() }] });
const records = (...pairs) => ({
  records: pairs.map(([taskId, iso, kind]) => ({ taskId, kind: kind || 'done', at: at(iso).toISOString() })),
});

console.log('\nBefore the deadline');
check('nothing is overdue at 20:00 when the deadline is 21:00',
  sched.findOverdue(readTask, empty, WED_2000) === null);
check('level is clear before the deadline',
  sched.evaluateTask(readTask, empty, WED_2000).level === 'clear');

console.log('\nThe ladder');
check('nudge immediately after the deadline',
  sched.evaluateTask(readTask, empty, at('2026-09-09T21:05:00')).level === 'nudge');
check('persistent at 45 minutes late',
  sched.evaluateTask(readTask, empty, at('2026-09-09T21:46:00')).level === 'persistent');
check('shield_social at 90 minutes late',
  sched.evaluateTask(readTask, empty, at('2026-09-09T22:31:00')).level === 'shield_social');
check('shield_all at 4 hours late',
  sched.evaluateTask(readTask, empty, at('2026-09-10T01:05:00')).level === 'shield_all');
check('a rung boundary counts as reached, not passed',
  sched.tierFor(readTask, 45).level === 'persistent');

console.log('\nCompletion clears it');
check('done at 20:00 clears the 21:00 deadline',
  sched.findOverdue(readTask, doneAt('read', '2026-09-09T20:00:00'), WED_2300) === null);
check('done yesterday does not clear today',
  sched.evaluateTask(readTask, doneAt('read', '2026-09-08T20:00:00'), WED_2300).level !== 'clear');
check('a pass clears exactly as a completion does',
  sched.findOverdue(readTask, doneAt('read', '2026-09-09T20:00:00', 'pass'), WED_2300) === null);
check('another task being done does not clear this one',
  sched.evaluateTask(readTask, doneAt('gym', '2026-09-09T20:00:00'), WED_2300).level !== 'clear');

console.log('\nCadence shapes');
check('weekdays task is overdue on a Wednesday evening',
  sched.evaluateTask(emailTask, empty, WED_2000).level !== 'clear');
check('a Saturday is not a weekday deadline of its own',
  sched.isScheduledDay(emailTask, SAT) === false);
check('daily task is scheduled every day including Saturday',
  sched.isScheduledDay(readTask, SAT) === true);
check('specific-days cadence honours its day list',
  sched.isScheduledDay({ cadence: { type: 'days', days: ['mon', 'thu'] } }, at('2026-09-10T12:00:00')) === true &&
  sched.isScheduledDay({ cadence: { type: 'days', days: ['mon', 'thu'] } }, WED_2000) === false);

console.log('\neveryNDays counts from the last time you did it');
const gym = { id: 'gym', title: 'Move', cadence: { type: 'everyNDays', n: 2, dueBy: '21:00' } };
check('not due one day after doing it',
  sched.findOverdue(gym, doneAt('gym', '2026-09-08T19:00:00'), WED_2000) === null);
check('due once N days have passed',
  sched.findOverdue(gym, doneAt('gym', '2026-09-07T19:00:00'), WED_2130) !== null);

console.log('\nA new task is not retroactively late');
check('a task added today is not two weeks behind',
  sched.findOverdue({ id: 'new', cadence: { type: 'daily', dueBy: '21:00' } }, empty, WED_2000) === null);
check('a task started a week ago and never done reports the whole week',
  sched.findOverdue({ ...readTask, startedOn: '2026-09-02' }, empty, WED_2300).overdueMinutes > 6 * 1440);

console.log('\nThe debt is the oldest miss, not the newest');
// Wednesday cleared, Thursday and Friday not. It should report Thursday.
const backlog = sched.findOverdue(readTask, doneAt('read', '2026-09-09T20:00:00'), at('2026-09-11T23:00:00'));
check('with two days missed it reports the older one',
  backlog.overdueMinutes > 24 * 60);
check('and it names the older deadline, not the recent one',
  sched.dayKey(backlog.dueAt) === '2026-09-10');

console.log('\nThe union rule');
// Thursday 23:00. Read was cleared Wednesday but not Thursday (2h late).
// Email has not been cleared since Wednesday's 17:00 deadline (30h late).
const THU_2300 = at('2026-09-10T23:00:00');
const readOnly = doneAt('read', '2026-09-09T20:00:00');
const both = sched.buildEnforcement([readTask, emailTask], readOnly, THU_2300);
check('the highest level across tasks wins',
  both.level === 'shield_social');
check('groups from every shielding task are merged',
  both.shieldGroups.includes('distractions') && both.shieldGroups.includes('games'));
check('a task at shield_all raises the whole payload', (() => {
  const out = sched.buildEnforcement([readTask, emailTask], empty, THU_2300);
  return out.level === 'shield_all';
})());
check('finishing one task does not drop the other group', (() => {
  // Read cleared on both days; email still 30h late.
  const out = sched.buildEnforcement([readTask, emailTask],
    records(['read', '2026-09-09T20:00:00'], ['read', '2026-09-10T20:00:00']), THU_2300);
  return out.shieldGroups.includes('games') && !out.shieldGroups.includes('distractions');
})());
check('both done means clear', (() => {
  const out = sched.buildEnforcement([readTask, emailTask], records(
    ['read', '2026-09-09T20:00:00'], ['read', '2026-09-10T20:00:00'],
    ['email', '2026-09-09T16:00:00'], ['email', '2026-09-10T16:00:00'],
  ), THU_2300);
  return out.level === 'clear' && out.blocking === false && out.shieldGroups.length === 0;
})());

console.log('\nThe confirmation cap');
const unconfirmed = { ...readTask, id: 'auto', confirmed: false };
check('an unconfirmed task can still reach persistent',
  sched.evaluateTask(unconfirmed, empty, at('2026-09-09T21:46:00')).level === 'persistent');
check('an unconfirmed task cannot reach a shield',
  sched.evaluateTask(unconfirmed, empty, THU_0400).level === 'persistent');
check('the cap is reported so the dashboard can explain it',
  sched.evaluateTask(unconfirmed, empty, THU_0400).capped === true);

console.log('\nPaused tasks');
check('a paused task never contributes',
  sched.evaluateTask({ ...readTask, paused: true }, empty, THU_0400).level === 'clear');

console.log('\nPasses');
const passHistory = { records: [
  { taskId: 'read', kind: 'pass', at: at('2026-09-08T20:00:00').toISOString() },
  { taskId: 'gym', kind: 'pass', at: at('2026-09-05T20:00:00').toISOString() },
  { taskId: 'gym', kind: 'pass', at: at('2026-08-01T20:00:00').toISOString() },
  { taskId: 'read', kind: 'done', at: at('2026-09-09T20:00:00').toISOString() },
] };
check('passes inside the 7-day window are counted',
  sched.passesUsed(passHistory, WED_2300) === 2);
check('a pass from last month has expired out of the window',
  sched.passesUsed(passHistory, WED_2300) !== 3);
check('completions are not counted as passes',
  sched.passesUsed({ records: [{ taskId: 'read', kind: 'done', at: WED_2000.toISOString() }] }, WED_2300) === 0);

console.log('\nThe payload the client actually reads');
const payload = sched.buildEnforcement([readTask], empty, THU_0400);
check('level is one the client knows',
  sched.LEVELS.includes(payload.level));
check('blocking matches the level',
  payload.blocking === true);
check('reasons carry a title, a duration and a fix',
  payload.reasons[0].title === 'Read a book' &&
  /\d/.test(payload.reasons[0].overdueFor) &&
  payload.reasons[0].clearedBy === 'Run the timer');
check('reasons are ordered worst first', (() => {
  const out = sched.buildEnforcement([readTask, emailTask], empty, THU_0400);
  return out.reasons.length === 2 && out.reasons[0].taskId === 'email';
})());
check('a clear payload names no groups',
  sched.buildEnforcement([], empty, THU_0400).shieldGroups.length === 0);

console.log('\nDuration wording');
check('minutes under an hour', sched.formatDuration(12) === '12m');
check('hours and minutes', sched.formatDuration(190) === '3h 10m');
check('days and hours', sched.formatDuration(3120) === '2d 4h');
check('zero never reads as 0m', sched.formatDuration(0) === '1m');

console.log('\nDegradation');
check('a task with no escalation gets the default ladder',
  sched.evaluateTask(
    { id: 'x', title: 'x', startedOn: '2026-09-09', cadence: { type: 'daily', dueBy: '21:00' } },
    empty, THU_0400).level === 'shield_all');
check('an unknown cadence type is never due rather than always due',
  sched.findOverdue({ id: 'x', cadence: { type: 'nonsense' } }, empty, THU_0400) === null);
check('a missing dueBy falls back to end of day',
  sched.deadlineOn(WED_2000, undefined).getHours() === 23);

console.log('\nOne-off deadlines (homework, exams)');
const hwTask = {
  id: 'hw:m408c:problem set 3',
  title: 'Problem Set 3',
  cadence: { type: 'once', dueAt: new Date(2026, 8, 15, 23, 59).toISOString() },
  escalation: [
    { afterMinutes: -1440, level: 'nudge' },
    { afterMinutes: -180, level: 'persistent' },
    { afterMinutes: 60, level: 'shield_social', groups: ['distractions'] },
    { afterMinutes: 720, level: 'shield_all' },
  ],
};
check('two days out, nothing yet',
  sched.evaluateTask(hwTask, empty, at('2026-09-13T20:00:00')).level === 'clear');
check('the day before, it nudges',
  sched.evaluateTask(hwTask, empty, at('2026-09-15T08:00:00')).level === 'nudge');
check('three hours out, it is persistent',
  sched.evaluateTask(hwTask, empty, at('2026-09-15T21:30:00')).level === 'persistent');
check('before the deadline it reports "due in", not "late"', (() => {
  const e = sched.evaluateTask(hwTask, empty, at('2026-09-15T21:30:00'));
  return e.dueIn !== null && e.overdue === null;
})());
check('an hour late, it shields',
  sched.evaluateTask(hwTask, empty, at('2026-09-16T01:00:00')).level === 'shield_social');
check('marking it done clears it for good',
  sched.evaluateTask(hwTask, doneAt(hwTask.id, '2026-09-15T20:00:00'), at('2026-09-20T12:00:00')).level === 'clear');
check('it has no next deadline once done',
  sched.nextDue(hwTask, doneAt(hwTask.id, '2026-09-15T20:00:00'), at('2026-09-14T12:00:00')) === null);
check('unconfirmed homework cannot shield however late',
  sched.evaluateTask({ ...hwTask, confirmed: false }, empty, at('2026-09-17T12:00:00')).level === 'persistent');
check('a pre-deadline reason says "due in" in the payload', (() => {
  const p = sched.buildEnforcement([hwTask], empty, at('2026-09-15T21:30:00'));
  return p.reasons.length === 1 && p.reasons[0].dueIn && p.reasons[0].overdueFor === null;
})());
check('late items sort ahead of ones merely coming up', (() => {
  const late = { ...hwTask, id: 'late', cadence: { type: 'once', dueAt: new Date(2026, 8, 14, 12).toISOString() } };
  const p = sched.buildEnforcement([hwTask, late], empty, at('2026-09-15T21:30:00'));
  return p.reasons[0].taskId === 'late';
})());
check('a bad date is ignored rather than crashing',
  sched.evaluateTask({ ...hwTask, cadence: { type: 'once', dueAt: 'nonsense' } }, empty, THU_0400).level === 'clear');

console.log('\nEarly warnings on recurring tasks');
const laundry = {
  id: 'laundry', title: 'Laundry', startedOn: '2026-09-13',
  cadence: { type: 'days', days: ['sun'], dueBy: '20:00' },
  escalation: [
    { afterMinutes: -240, level: 'nudge' },
    { afterMinutes: 0, level: 'persistent' },
    { afterMinutes: 720, level: 'shield_social', groups: ['distractions'] },
  ],
};
check('Sunday morning, not yet',
  sched.evaluateTask(laundry, empty, at('2026-09-13T10:00:00')).level === 'clear');
check('Sunday 17:00, a heads-up',
  sched.evaluateTask(laundry, empty, at('2026-09-13T17:00:00')).level === 'nudge');
check('Sunday 21:00, persistent',
  sched.evaluateTask(laundry, empty, at('2026-09-13T21:00:00')).level === 'persistent');
check('Monday 09:00, shielding',
  sched.evaluateTask(laundry, empty, at('2026-09-14T09:00:00')).level === 'shield_social');
check('done on Sunday afternoon, quiet all week',
  sched.evaluateTask(laundry, doneAt('laundry', '2026-09-13T15:00:00'), at('2026-09-16T12:00:00')).level === 'clear');
check('a Wednesday is not a laundry day',
  sched.evaluateTask(laundry, doneAt('laundry', '2026-09-13T15:00:00'), at('2026-09-16T19:00:00')).level === 'clear');
check('a ladder without early rungs still stays quiet before the deadline',
  sched.evaluateTask(readTask, empty, WED_2000).level === 'clear');

console.log('\nLate and early completions');
check('laundry due Sunday, done Monday morning, is no longer overdue',
  sched.evaluateTask(laundry, doneAt('laundry', '2026-09-14T09:30:00'), at('2026-09-14T10:00:00')).level === 'clear');
check('and stays quiet for the rest of the week',
  sched.evaluateTask(laundry, doneAt('laundry', '2026-09-14T09:30:00'), at('2026-09-18T12:00:00')).level === 'clear');
check('and next Sunday is due again',
  sched.evaluateTask(laundry, doneAt('laundry', '2026-09-14T09:30:00'), at('2026-09-20T21:00:00')).level === 'persistent');
check('laundry done early on Saturday counts for Sunday',
  sched.evaluateTask(laundry, records(['laundry', '2026-09-13T12:00:00'], ['laundry', '2026-09-19T15:00:00']),
    at('2026-09-20T22:00:00')).level === 'clear');
check('doing it twice on Saturday does not pre-clear the week after', (() => {
  const twice = records(['laundry', '2026-09-19T15:00:00'], ['laundry', '2026-09-19T16:00:00']);
  return sched.evaluateTask({ ...laundry, startedOn: '2026-09-14' }, twice, at('2026-09-27T22:00:00')).level === 'persistent';
})());
check('a daily task done an hour late still counts for that day',
  sched.evaluateTask(readTask, doneAt('read', '2026-09-09T22:00:00'), at('2026-09-09T23:30:00')).level === 'clear');
check('with two days missed, one late completion pays off the older one', (() => {
  const once = doneAt('read', '2026-09-11T10:00:00');
  const miss = sched.findOverdue(readTask, once, at('2026-09-11T10:30:00'));
  return miss && sched.dayKey(miss.dueAt) === '2026-09-10';
})());
check('the current occurrence of a Sunday task on a Wednesday is the Sunday before',
  sched.currentOccurrenceKey(laundry, at('2026-09-16T12:00:00')) === '2026-09-13');
check('a completion from before a task started counts for nothing',
  sched.satisfiedOccurrences(readTask, doneAt('read', '2026-09-01T20:00:00'), WED_2300).size === 0);

console.log(`\n${pass} passing, ${fail} failing\n`);
process.exit(fail === 0 ? 0 : 1);
