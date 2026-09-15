'use strict';
/**
 * homework.js - decide whether an email or a calendar event is schoolwork,
 * and if so what it is called and when it is due.
 *
 * This errs towards missing things rather than inventing them. Every task it
 * produces arrives unconfirmed, which caps it at "persistent": it can nag but
 * it cannot take your machine away until you have said it is real. A parser
 * that locks you out over a misread newsletter is one you stop trusting in a
 * week, and then it has failed at the only job it had.
 */

const { findDueDate } = require('./dates');

const LMS_SENDER = /instructure\.com|canvaslms\.com|canvas\b|gradescope\.com|blackboard\.com|brightspace|d2l\.com|moodle/i;

const WORK_WORDS = /\b(assignment|homework|hw\s*#?\d*|problem\s+set|p-?set|quiz(?:zes)?|exam|midterm|final\s+exam|project|essay|paper|lab\s+report|reading\s+response|response\s+paper|discussion\s+post|submission|due|deadline)\b/i;

const EXAM_WORDS = /\b(exam|midterm|final\s+exam|test\s+\d|prelim)\b/i;

// Mail that mentions an assignment but asks nothing of you.
const NOT_WORK = /\b(graded|grade\s+(?:has\s+been\s+)?posted|grades?\s+(?:are\s+)?(?:now\s+)?available|submission\s+(?:received|confirmation|confirmed)|successfully\s+submitted|has\s+been\s+submitted|you\s+submitted|feedback\s+(?:is\s+)?(?:available|posted)|score\s+posted|regrade|office\s+hours|was\s+(?:excused|cancel+ed)|assignment\s+(?:deleted|removed))\b/i;

const CANVAS_SUBJECT = /^assignment\s+(?:created|due\s+date\s+changed|due\s+date\s+override\s+changed|updated|reminder|upcoming)\s*[-:–—]\s*(.+?)(?:,\s*([^,]{2,60}))?\s*$/i;

const COURSE_CODE = /\b([A-Z]{1,4})[\s-]?(\d{3}[A-Z]?)\b/;
// Case-insensitive only when the whole string is the code, so "eco 112" is
// recognised but "see page 112" in a sentence is not.
const COURSE_CODE_WHOLE = /^\s*([A-Z]{1,4})[\s-]?(\d{3}[A-Z]?)\s*$/i;

// Moodle and Banner prefix a subject with every cross-listed section:
// "DAN-119-1/AFR-119-1/CRE-119-1-202690: QUIZ - Bronx is Burning".
// The first code is the course; the rest is noise.
const SECTION_PREFIX = /^\s*([A-Z]{2,4})-(\d{3}[A-Z]?)(?:-\d+)?(?:\/[A-Z]{2,4}-\d{3}[A-Z]?(?:-\d+)*)*(?:-\d{4,})?\s*:\s*/;

// "QUIZ - Bronx is Burning" reads better as "Quiz: Bronx is Burning".
const KIND_LEAD = /^(quiz|exam|midterm|final|homework|assignment|essay|paper|lab\s+report|reading\s+response|problem\s+set|project|discussion\s+post)\s*[-:–—]\s*(.+)$/i;

// A class session about an exam is not the exam, and a paper being handed out
// is not a paper being handed in. Both only count if they also say "due".
const NOT_A_DEADLINE = /\b(review|prep|preparation|study\s+session|study\s+guide|assigned|handed\s+out|office\s+hours|lecture|recitation|discussion\s+section|study\s+group)\b/i;

/** "ECO112", "eco 112", "DAN-119" -> "ECO 112", "DAN 119". */
function canonicalCourse(s) {
  const m = COURSE_CODE_WHOLE.exec(String(s || ''));
  return m ? `${m[1].toUpperCase()} ${m[2].toUpperCase()}` : String(s || '').trim();
}

/**
 * Loud all-caps titles - "IN-CLASS EXAM #1", "MIDTERM I" - brought down to
 * normal case. Mixed-case titles are left exactly as the professor wrote them.
 */
function tidyCase(s) {
  const letters = String(s).replace(/[^A-Za-z]/g, '');
  const upper = letters.replace(/[^A-Z]/g, '').length;
  if (letters.length < 4 || upper / letters.length <= 0.8) return String(s);
  return String(s).toLowerCase().replace(/\b([a-z])([a-z]*)/g, (m, a, b) => {
    const word = a + b;
    if (/^(i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)$/.test(word)) return word.toUpperCase();
    return a.toUpperCase() + b;
  });
}

/**
 * "ECO112 — Homework 1" -> course ECO 112, title "Homework 1". Course calendars
 * are almost always written as "Course — thing", and repeating the course in
 * the title next to a course label is just clutter.
 *
 * Only an em or en dash splits a free-form prefix like "Intl Politics", since
 * a hyphen is too common inside real titles. A code-shaped prefix may use a
 * hyphen or colon.
 */
function splitCoursePrefix(title) {
  const t = String(title || '');
  let m = /^\s*([A-Z]{1,4}[\s-]?\d{3}[A-Z]?)\s*[—–:-]\s+(.+)$/.exec(t);
  if (m) return { course: canonicalCourse(m[1]), rest: m[2].trim() };

  m = /^\s*(.{2,40}?)\s+[—–]\s+(.+)$/.exec(t);
  if (!m) return null;
  const prefix = m[1].trim();
  const words = prefix.split(/\s+/).length;
  if (words > 4 || WORK_WORDS.test(prefix) || NOT_A_DEADLINE.test(prefix)) return null;
  return { course: canonicalCourse(prefix), rest: m[2].trim() };
}

/** The same tidy-up for every title, wherever it came from. */
function polishTitle(raw, course) {
  let s = String(raw || '').trim();
  let c = course || '';

  const sec = SECTION_PREFIX.exec(s);
  if (sec) {
    if (!c) c = `${sec[1]} ${sec[2]}`;
    s = s.slice(sec[0].length);
  }

  const split = splitCoursePrefix(s);
  if (split) {
    if (!c) c = split.course;
    if (canonicalCourse(split.course).toLowerCase() === canonicalCourse(c).toLowerCase() || !course) s = split.rest;
  }

  // "Problem Set 3 is due Friday" -> "Problem Set 3"
  s = s.replace(/\s*[-–—:|,(]?\s*(?:is\s+|are\s+)?(?:now\s+)?(?:due|deadline)\b.*$/i, '');
  s = s.replace(/\s*[-–—:|]\s*$/, '').trim();

  const kind = KIND_LEAD.exec(s);
  if (kind) s = `${tidyCase(kind[1]).replace(/^./, (x) => x.toUpperCase())}: ${kind[2].trim()}`;

  return { title: tidyCase(s), course: c ? canonicalCourse(c) : '' };
}

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(new|reminder|due|the|a|an|is|now|upcoming|assignment\s+created|posted)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The subject line, with the parts that are not the assignment's name removed.
 */
function extractTitle(subject) {
  let s = String(subject || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim();

  const canvas = CANVAS_SUBJECT.exec(s);
  if (canvas) {
    return polishTitle(canvas[1], canvas[2] ? canvas[2].trim() : '');
  }

  let course = '';
  const tag = /^\s*\[([^\]]{2,40})\]\s*/.exec(s);
  if (tag) {
    course = tag[1].trim();
    s = s.slice(tag[0].length);
  }

  s = s.replace(/^(reminder|announcement|important|update|fyi|heads\s+up)\s*[:\-–]\s*/i, '');

  const polished = polishTitle(s, course);
  if (!polished.course) {
    const code = COURSE_CODE.exec(subject);
    if (code) polished.course = canonicalCourse(`${code[1]} ${code[2]}`);
  }
  if (!polished.title) polished.title = String(subject || '').trim();
  return polished;
}

/**
 * Titles like "Quiz" or "Homework" repeat every week in the same course, so a
 * key built from the title alone would merge them. Those get the due day added.
 */
function keyFor(title, course, dueAt) {
  const t = normalize(title);
  const generic = t.split(' ').filter(Boolean).length < 2 ||
    /^(quiz|homework|hw|assignment|exam|reading|lab|essay|paper|project|discussion)( \d+)?$/.test(t) && !/\d/.test(t);
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${dueAt.getFullYear()}-${pad(dueAt.getMonth() + 1)}-${pad(dueAt.getDate())}`;
  return `hw:${normalize(course)}:${t}${generic ? `:${day}` : ''}`;
}

/**
 * One Gmail message -> a homework candidate, or null.
 *
 * `msg` is the normalised shape produced by sync.js:
 *   { id, threadId, subject, from, fromAddress, date, body, snippet, labels, bulk }
 */
function fromEmail(msg, account) {
  const labels = msg.labels || [];
  if (labels.includes('CATEGORY_PROMOTIONS') || labels.includes('CATEGORY_SOCIAL')) return null;
  if (labels.includes('SENT') || labels.includes('DRAFT')) return null;

  const subject = String(msg.subject || '');
  const body = String(msg.body || msg.snippet || '');
  const fromLms = LMS_SENDER.test(msg.fromAddress || msg.from || '');

  // A newsletter mentioning "this semester's deadlines" is not homework. Bulk
  // mail only counts when it comes from the course site itself.
  if (msg.bulk && !fromLms) return null;

  if (/recent canvas notifications/i.test(subject)) return null;
  if (NOT_WORK.test(subject)) return null;
  if (NOT_WORK.test(body.slice(0, 400))) return null;

  const subjectLooksLikeWork = WORK_WORDS.test(subject);
  if (!fromLms && !subjectLooksLikeWork) return null;
  if (NOT_A_DEADLINE.test(subject) && !/\bdue\b/i.test(subject)) return null;

  const reference = msg.date instanceof Date ? msg.date : new Date(msg.date);
  if (Number.isNaN(reference.getTime())) return null;

  // The body is where the real date lives - with a time, usually - so it is
  // tried first. The subject is the fallback, where proximity to a due-word
  // is not required: "HW 3 - Friday" is plainly a deadline.
  const due = findDueDate(body, reference) ||
    (subjectLooksLikeWork ? findDueDate(subject, reference, { window: Infinity, keepQuoted: true }) : null);
  if (!due) return null;

  // A deadline more than a day before the email was sent is not something
  // this email is asking you to do.
  if (due.date.getTime() < reference.getTime() - 86400000) return null;

  const { title, course } = extractTitle(subject);
  const kind = EXAM_WORDS.test(subject) && !/\b(assignment|homework|submit|paper|project|essay|quiz)\b/i.test(subject)
    ? 'exam' : 'homework';

  return {
    key: keyFor(title, course, due.date),
    kind,
    title,
    course,
    dueAt: due.date,
    hasTime: due.hasTime,
    source: {
      type: 'email',
      account,
      ref: msg.id,
      thread: msg.threadId,
      subject,
      from: msg.from || '',
      at: reference.toISOString(),
    },
  };
}

/**
 * One calendar event -> a homework candidate, or null.
 *
 * `ev` is the normalised shape produced by sync.js:
 *   { id, calendarName, title, description, start, end, allDay, recurring, htmlLink }
 */
function fromEvent(ev, account) {
  const title = String(ev.title || '');
  const calendarIsLms = LMS_SENDER.test(`${ev.calendarName || ''} ${ev.htmlLink || ''} ${(ev.description || '').slice(0, 300)}`);

  // Recurring events are class meetings - the schedule, not the work. A
  // course-site calendar is the exception, since every entry there is a
  // deadline, but even those are one-off events in practice.
  if (ev.recurring && !calendarIsLms) return null;
  if (!calendarIsLms && !WORK_WORDS.test(title)) return null;
  if (NOT_WORK.test(title)) return null;
  // "Review — Midterm I prep" and "Book X — FIRST PAPER ASSIGNED" both name an
  // exam or a paper, and neither is a deadline. Only "due" overrides that.
  if (!calendarIsLms && NOT_A_DEADLINE.test(title) && !/\bdue\b/i.test(title)) return null;

  const start = ev.start instanceof Date ? ev.start : new Date(ev.start);
  if (Number.isNaN(start.getTime())) return null;

  // An all-day "Essay due" means by the end of that day.
  const dueAt = ev.allDay
    ? new Date(start.getFullYear(), start.getMonth(), start.getDate(), 23, 59, 0, 0)
    : start;

  const polished = polishTitle(title.replace(/^\s*(due|deadline)\s*[:\-–]\s*/i, ''), '');
  const cleaned = polished.title || title;
  let course = polished.course;
  if (!course) {
    const code = COURSE_CODE.exec(title);
    if (code) course = canonicalCourse(`${code[1]} ${code[2]}`);
  }
  const kind = EXAM_WORDS.test(title) && !/\bquiz\b/i.test(title) ? 'exam' : 'homework';

  return {
    key: keyFor(cleaned, course, dueAt),
    kind,
    title: cleaned,
    course,
    dueAt,
    hasTime: !ev.allDay,
    source: {
      type: 'calendar',
      account,
      ref: ev.id,
      subject: title,
      from: ev.calendarName || '',
      link: ev.htmlLink || '',
      at: new Date().toISOString(),
    },
  };
}

// Bumped whenever the rules above change what a title or key looks like, so a
// sync knows to re-read what it captured under the old rules.
const EXTRACT_VERSION = 2;

module.exports = {
  fromEmail, fromEvent, extractTitle, keyFor, normalize, polishTitle, canonicalCourse, tidyCase,
  LMS_SENDER, EXTRACT_VERSION,
};
