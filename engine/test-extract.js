'use strict';
/**
 * test-extract.js - reading deadlines out of email and calendar entries.
 *
 * The cases are the shapes of mail a student actually gets: Canvas
 * notifications, a professor's reminder, a quoted reply thread, a newsletter
 * that happens to say "deadline", a graded-assignment notice.
 *
 *   node test-extract.js
 */

const dates = require('./lib/extract/dates');
const hw = require('./lib/extract/homework');
const replies = require('./lib/extract/replies');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

// Wednesday 9 September 2026, mid-morning.
const REF = new Date(2026, 8, 9, 10, 0, 0);
// A miss returns {} so one failed parse reports as a FAIL instead of ending the run.
const fd = (...args) => dates.findDueDate(...args) || {};
const ymd = (d) => d && `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const hm = (d) => d && `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

console.log('\nDue dates: explicit');
let r = fd('This assignment is due Sep 15 at 11:59pm.', REF);
check('"due Sep 15 at 11:59pm"', ymd(r.date) === '2026-9-15' && hm(r.date) === '23:59');
r = fd('Due: September 18, 2026 at 5:00 PM', REF);
check('"September 18, 2026 at 5:00 PM"', ymd(r.date) === '2026-9-18' && hm(r.date) === '17:00');
r = fd('Submit by 9/22 at noon', REF);
check('"by 9/22 at noon"', ymd(r.date) === '2026-9-22' && hm(r.date) === '12:00');
r = fd('Deadline 2026-10-01', REF);
check('ISO date', ymd(r.date) === '2026-10-1');
r = fd('due on 15 September', REF);
check('day before month', ymd(r.date) === '2026-9-15');

console.log('\nDue dates: no time given');
r = fd('Essay due Sep 20', REF);
check('defaults to the end of the day', hm(r.date) === '23:59' && r.hasTime === false);

console.log('\nDue dates: relative');
r = fd('Problem set is due Friday', REF);
check('"due Friday" is this coming Friday', ymd(r.date) === '2026-9-11');
r = fd('This is due next Friday', REF);
check('"next Friday" is the week after', ymd(r.date) === '2026-9-18');
r = fd('Reading response due tomorrow by 9am', REF);
check('"tomorrow by 9am"', ymd(r.date) === '2026-9-10' && hm(r.date) === '9:00');
r = fd('Turn it in tonight', REF);
check('"tonight" is today', ymd(r.date) === '2026-9-9');
r = fd('due Wednesday', REF);
check('a weekday that is today means today', ymd(r.date) === '2026-9-9');
r = fd('Due Friday at midnight', REF);
check('"midnight" means the end of that day', ymd(r.date) === '2026-9-11' && hm(r.date) === '23:59');

console.log('\nDue dates: timezones');
r = fd('due Sep 15 at 11:59pm CDT', REF);
check('CDT is honoured', r.date.toISOString() === '2026-09-16T04:59:00.000Z');
r = fd('due Sep 15 at 11:59 PM (EST)', REF);
check('a bracketed zone is honoured', r.date.toISOString() === '2026-09-16T04:59:00.000Z');

console.log('\nDue dates: things that are not deadlines');
check('a date with no due-word nearby is ignored',
  dates.findDueDate('We met on September 3 to talk about the club.', REF) === null);
check('text with no date returns null',
  dates.findDueDate('Please finish the reading when you can.', REF) === null);
check('Feb 30 is rejected, not rolled into March',
  dates.findDueDate('due Feb 30', REF) === null);
check('a quoted reply header does not become the deadline', (() => {
  const text = 'Thanks, that works!\n\nOn Mon, Sep 7, 2026 at 3:14 PM Prof Smith wrote:\n> The project is due Sep 30';
  return dates.findDueDate(text, REF) === null;
})());
check('the date nearest the due-word wins', (() => {
  const text = 'Class on September 10 is cancelled. The lab report is due September 24.';
  return ymd(dates.findDueDate(text, REF).date) === '2026-9-24';
})());

console.log('\nYear inference');
check('a January date read in December is next year',
  dates.inferYear(0, 12, new Date(2026, 11, 1)) === 2027);
check('a September date read in September is this year',
  dates.inferYear(8, 15, REF) === 2026);

console.log('\nTitles');
let t = hw.extractTitle('Assignment Created - Problem Set 3, M 408C');
check('Canvas "Assignment Created" subject', t.title === 'Problem Set 3' && t.course === 'M 408C');
t = hw.extractTitle('Assignment Due Date Changed - Lab Report 2, CH 301');
check('Canvas "Due Date Changed" subject', t.title === 'Lab Report 2' && t.course === 'CH 301');
t = hw.extractTitle('[BIO 311C] Reading response is due Friday');
check('a bracketed course tag and a trailing "is due"', t.title === 'Reading response' && t.course === 'BIO 311C');
t = hw.extractTitle('Re: Reminder: Essay 1 due Monday');
check('Re: and Reminder: are stripped', t.title === 'Essay 1');

const mail = (over) => ({
  id: 'm1', threadId: 't1', subject: '', from: '', fromAddress: '',
  date: REF, body: '', labels: ['INBOX'], bulk: false, ...over,
});

console.log('\nHomework from email: yes');
let c = hw.fromEmail(mail({
  subject: 'Assignment Created - Problem Set 3, M 408C',
  from: 'Canvas <notifications@instructure.com>', fromAddress: 'notifications@instructure.com',
  body: 'A new assignment has been created for your course.\n\nProblem Set 3, M 408C\n\ndue: Sep 15 at 11:59pm',
  bulk: true,
}), 'me@utexas.edu');
check('a Canvas notification becomes homework', c && c.kind === 'homework');
check('with the right title and course', !!c && c.title === 'Problem Set 3' && c.course === 'M 408C');
check('and the right deadline', !!c && ymd(c.dueAt) === '2026-9-15' && hm(c.dueAt) === '23:59');
check('Canvas bulk mail is still allowed through', c !== null);

c = hw.fromEmail(mail({
  subject: 'HW 4 due Friday',
  from: 'Prof. Lee <lee@utexas.edu>', fromAddress: 'lee@utexas.edu',
  body: 'Hi all, a reminder that HW 4 is due this Friday by 5pm. See you in class.',
}), 'me@utexas.edu');
check('a professor\'s reminder becomes homework', c && ymd(c.dueAt) === '2026-9-11' && hm(c.dueAt) === '17:00');

c = hw.fromEmail(mail({
  subject: 'BIO 311C Midterm 1 reminder',
  from: 'TA <ta@utexas.edu>', fromAddress: 'ta@utexas.edu',
  body: 'Midterm 1 is Thursday September 17 at 7pm in Gregory Gym. The exam is due to start promptly.',
}), 'me@utexas.edu');
check('an exam is classed as an exam', c && c.kind === 'exam');

console.log('\nHomework from email: no');
check('a graded notice is not new work', hw.fromEmail(mail({
  subject: 'Assignment Graded - Problem Set 2, M 408C',
  fromAddress: 'notifications@instructure.com', from: 'notifications@instructure.com',
  body: 'Your assignment has been graded. due: Sep 8', bulk: true,
}), 'x') === null);
check('a submission receipt is not new work', hw.fromEmail(mail({
  subject: 'Submission received: Essay 1', fromAddress: 'turnitin@turnitin.com',
  body: 'Your submission has been received. It was due Sep 8.',
}), 'x') === null);
check('a marketing email that says "deadline" is ignored', hw.fromEmail(mail({
  subject: 'Last chance: deadline for 50% off Grammarly Pro',
  fromAddress: 'hello@mail.grammarly.com', body: 'Offer deadline Sep 12!', bulk: true,
}), 'x') === null);
check('the promotions tab is skipped whatever it says', hw.fromEmail(mail({
  subject: 'Homework help due Friday', labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
  fromAddress: 'ads@example.com', body: 'due Friday',
}), 'x') === null);
check('work-sounding mail with no deadline in it is skipped', hw.fromEmail(mail({
  subject: 'Project groups', fromAddress: 'lee@utexas.edu',
  body: 'Please form groups of three for the semester project.',
}), 'x') === null);
check('a deadline long before the email was sent is skipped', hw.fromEmail(mail({
  subject: 'Late policy for HW 1', fromAddress: 'lee@utexas.edu',
  body: 'HW 1 was due Sep 1. Late submissions lose 10%.',
}), 'x') === null);
check('mail you sent yourself is skipped', hw.fromEmail(mail({
  subject: 'HW 4 due Friday', labels: ['SENT'], fromAddress: 'me@utexas.edu', body: 'due Friday',
}), 'x') === null);

const ev = (over) => ({
  id: 'e1', calendarName: 'me@utexas.edu', title: '', description: '',
  start: new Date(2026, 8, 15, 23, 59), end: new Date(2026, 8, 15, 23, 59),
  allDay: false, recurring: false, htmlLink: '', ...over,
});

console.log('\nHomework from the calendar');
c = hw.fromEvent(ev({ title: 'Essay 2 due' }), 'x');
check('"Essay 2 due" becomes homework', c && c.title === 'Essay 2');
c = hw.fromEvent(ev({ title: 'Lab report due', allDay: true, start: new Date(2026, 8, 18) }), 'x');
check('an all-day deadline means the end of that day', c && hm(c.dueAt) === '23:59' && ymd(c.dueAt) === '2026-9-18');
c = hw.fromEvent(ev({ title: 'BIO 311C Midterm 1', start: new Date(2026, 8, 17, 19, 0) }), 'x');
check('an exam event is an exam, due at its start', c && c.kind === 'exam' && hm(c.dueAt) === '19:00' && c.course === 'BIO 311C');
c = hw.fromEvent(ev({ title: 'Problem Set 3', calendarName: 'Canvas', htmlLink: 'https://utexas.instructure.com/x' }), 'x');
check('anything on a Canvas calendar is a deadline, keyword or not', c !== null);
check('a recurring lecture is schedule, not work',
  hw.fromEvent(ev({ title: 'BIO 311C Lecture', recurring: true }), 'x') === null);
check('a one-off "Exam review" session is not a deadline',
  hw.fromEvent(ev({ title: 'Exam review session' }), 'x') === null);
check('a dentist appointment is not homework',
  hw.fromEvent(ev({ title: 'Dentist' }), 'x') === null);

console.log('\nDeduplication keys');
const d1 = new Date(2026, 8, 15, 23, 59);
check('the same assignment from email and calendar gets the same key',
  hw.keyFor('Problem Set 3', 'M 408C', d1) === hw.keyFor('problem set 3', 'M 408C', new Date(2026, 8, 15, 12)));
check('two weekly "Quiz" entries do not collide',
  hw.keyFor('Quiz', 'CH 301', d1) !== hw.keyFor('Quiz', 'CH 301', new Date(2026, 8, 22)));
check('different courses do not collide',
  hw.keyFor('Problem Set 3', 'M 408C', d1) !== hw.keyFor('Problem Set 3', 'PHY 303K', d1));

const ME = 'me@utexas.edu';
const thread = (messages, subject = 'Question') => ({ id: 't', subject, messages });
const msg = (over) => ({
  from: 'Alex <alex@utexas.edu>', to: ME, date: new Date(2026, 8, 8, 9), labels: ['INBOX'],
  bulk: false, autoSubmitted: false, snippet: 'Are you free to meet Thursday afternoon?', ...over,
});

console.log('\nWaiting on a reply: yes');
let w = replies.awaitingReply(thread([msg({})]), ME);
check('a person writing to you directly is waiting', w.waiting === true);
check('and the wait starts when they sent it', w.since.getTime() === new Date(2026, 8, 8, 9).getTime());
w = replies.awaitingReply(thread([
  msg({ from: ME, to: 'alex@utexas.edu', labels: ['SENT'], date: new Date(2026, 8, 7) }),
  msg({ to: 'group@utexas.edu', date: new Date(2026, 8, 8) }),
]), ME);
check('a reply to a thread you started counts even via a list', w.waiting === true);

console.log('\nWaiting on a reply: no');
check('you replied last', replies.awaitingReply(thread([
  msg({}), msg({ from: ME, labels: ['SENT'], date: new Date(2026, 8, 9) }),
]), ME).reason === 'you replied last');
check('archived threads have been dealt with', replies.awaitingReply(thread([
  msg({ labels: [] }),
]), ME).reason === 'archived');
check('newsletters never need a reply', replies.awaitingReply(thread([
  msg({ bulk: true }),
]), ME).waiting === false);
check('no-reply senders never need a reply', replies.awaitingReply(thread([
  msg({ from: 'UT <no-reply@utexas.edu>' }),
]), ME).reason === 'no-reply sender');
check('Canvas notifications are not conversations', replies.awaitingReply(thread([
  msg({ from: 'notifications@instructure.com' }),
]), ME).waiting === false);
check('a class-wide announcement is not addressed to you', replies.awaitingReply(thread([
  msg({ to: 'bio311c-students@utexas.edu' }),
]), ME).reason === 'not addressed to you');
check('the promotions tab never needs a reply', replies.awaitingReply(thread([
  msg({ labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }),
]), ME).waiting === false);
check('an automated message is skipped', replies.awaitingReply(thread([
  msg({ autoSubmitted: true }),
]), ME).waiting === false);
check('your aliases all count as you', replies.awaitingReply(thread([
  msg({}), msg({ from: 'Me <me.alias@utexas.edu>', date: new Date(2026, 8, 9) }),
]), [ME, 'me.alias@utexas.edu']).reason === 'you replied last');

console.log('\nWaiting on a reply: does it actually ask anything');
check('an itinerary that asks nothing is not a chore', replies.awaitingReply(thread([
  msg({ snippet: 'Attached are the itineraries for this weekend. See everyone there.' }),
], 'Visit itineraries'), ME).reason === 'does not ask you anything');
check('"let me know" counts as asking', replies.awaitingReply(thread([
  msg({ snippet: 'Send over your class schedule and let me know which practices you can make.' }),
], 'Schedules'), ME).waiting === true);
check('"please confirm" counts as asking', replies.awaitingReply(thread([
  msg({ snippet: 'Please confirm your spot by Friday.' }),
], 'Spring trip'), ME).waiting === true);
check('a calendar invitation is answered with a button, not an email', replies.awaitingReply(thread([
  msg({ snippet: 'You have been invited. Going?' }),
], 'Invitation: Club meeting @ Sun Sep 6, 2026 7pm - 8pm (EDT)'), ME).reason === 'invitation or announcement');
check('a "Reminder:" subject is skipped', replies.awaitingReply(thread([
  msg({ snippet: 'Can you make the make-up session?' }),
], 'Reminder: Make-up session this week'), ME).waiting === false);
check('an email to a crowd is an announcement', replies.awaitingReply(thread([
  msg({ to: [ME, 'a@x.edu', 'b@x.edu', 'c@x.edu', 'd@x.edu', 'e@x.edu', 'f@x.edu'].join(', '), snippet: 'Questions?' }),
], 'Team update'), ME).reason === 'sent to a crowd');
check('inside a back-and-forth, silence counts even without a question', replies.awaitingReply(thread([
  msg({ from: ME, to: 'alex@utexas.edu', labels: ['SENT'], date: new Date(2026, 8, 7) }),
  msg({ snippet: 'Sounds good, talk soon.', date: new Date(2026, 8, 8) }),
], 'Project'), ME).waiting === true);

console.log('\nReal course-calendar and course-site shapes');
c = hw.fromEvent(ev({ title: 'ECO112 — Homework 1 DUE', allDay: true, start: new Date(2026, 8, 15) }), 'x');
check('"ECO112 — Homework 1 DUE" drops the course from the title', !!c && c.title === 'Homework 1');
check('and files it under ECO 112', !!c && c.course === 'ECO 112');
check('a review session for a midterm is not the midterm',
  hw.fromEvent(ev({ title: 'ECO112 — Review — Midterm I prep' }), 'x') === null);
check('a paper being assigned is not a paper being due',
  hw.fromEvent(ev({ title: 'GOV 211 — Republic, Book X — FIRST PAPER ASSIGNED' }), 'x') === null);
c = hw.fromEvent(ev({ title: 'Intl Politics — IN-CLASS EXAM #1' }), 'x');
check('a named course prefix becomes the course', !!c && c.course === 'Intl Politics');
check('an all-caps title is brought down to normal case', !!c && c.title === 'In-Class Exam #1' && c.kind === 'exam');
c = hw.fromEvent(ev({ title: 'ECO112 — MIDTERM I' }), 'x');
check('roman numerals survive the case change', !!c && c.title === 'Midterm I');
c = hw.fromEmail(mail({
  subject: 'DAN-119-1/AFR-119-1/CRE-119-1-202690: QUIZ - Bronx is Burning - Due by Mon 9/14',
  from: 'Moodle <noreply@moodle.example.edu>', fromAddress: 'noreply@moodle.example.edu',
  body: 'The quiz is available now and closes Monday 9/14 at 11:59 PM.', bulk: true,
}), 'x');
check('cross-listed section codes collapse to one course', !!c && c.course === 'DAN 119');
check('and the title reads like a title', !!c && c.title === 'Quiz: Bronx is Burning');
check('a quiz is homework, not an exam', !!c && c.kind === 'homework');
check('with the deadline from the email', !!c && ymd(c.dueAt) === '2026-9-14');
check('a course code written without a space matches one written with it',
  hw.canonicalCourse('ECO112') === hw.canonicalCourse('eco 112'));

console.log(`\n${pass} passing, ${fail} failing\n`);
process.exit(fail === 0 ? 0 : 1);
