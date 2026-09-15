'use strict';
/**
 * labels.js - what kind of thing each calendar entry is, and whether you have
 * to be there: Class, Office hours, Practice, Game, Meeting, Exam... each one
 * Required or Optional.
 *
 * Read from the title, the calendar's name and the groups you are in. It is a
 * guess, made the same way every time, and you can overrule it: an entry you
 * mark Optional stays Optional, along with every other entry with that title.
 * Nothing here is sent anywhere.
 */

const TYPES = {
  class: { name: 'Class', attend: 'required' },
  lab: { name: 'Lab', attend: 'required' },
  exam: { name: 'Exam', attend: 'required' },
  office_hours: { name: 'Office hours', attend: 'optional' },
  review: { name: 'Review session', attend: 'optional' },
  practice: { name: 'Practice', attend: 'required' },
  game: { name: 'Game', attend: 'required' },
  meeting: { name: 'Meeting', attend: 'required' },
  appointment: { name: 'Appointment', attend: 'required' },
  work: { name: 'Work', attend: 'required' },
  travel: { name: 'Travel', attend: 'required' },
  social: { name: 'Social', attend: 'optional' },
  event: { name: 'Event', attend: null },
  holiday: { name: 'Holiday', attend: null },
};

const ATTEND = ['required', 'optional'];

// Course codes: "ECO 112", "GOV211", "CS 50".
const COURSE_CODE = /\b[A-Z]{2,5}\s?\d{2,3}[A-Z]?\b/;

// First match wins, so the specific kinds come before the general ones.
const RULES = [
  ['office_hours', /\boffice\s*hours?\b|\bstudent hours\b|\bdrop-?in hours\b/i],
  ['office_hours', /\bOH\b/],
  ['exam', /\b(midterm|final exam|exam|quiz|test)\b/i],
  ['review', /\b(review session|study (session|group|hall)|exam prep|help session|tutoring)\b/i],
  ['lab', /\blab\b(?!\s*report)/i],
  ['practice', /\b(practice|training|conditioning|lift(ing)?|workout|scrimmage|film session|rehearsal)\b/i],
  ['social', /\b(party|social|mixer|night|celebration|fundraiser|5k|run\/walk|dodgeball|pickleball|trivia|bingo|movie|halloween|formal|banquet|cookout|bbq|picnic|tournament)\b/i],
  ['game', /\bvs\.?\s|\b(game|match|regatta|invitational|championships?|meet)\b(?!\s+(with|up|and greet))/i],
  ['meeting', /\b(meeting|gbm|general body|committee|council|board|assembly|orientation|info session)\b/i],
  ['appointment', /\b(appointment|appt|dentist|doctor|advis(or|ing)|haircut|therapy|interview|check-?up|physical)\b/i],
  ['work', /\b(shift|work)\b/i],
  ['travel', /\b(flight|train to|bus to|drive to|departs?|boarding)\b/i],
  ['class', /\b(lecture|seminar|recitation|discussion section|class)\b/i],
];

const REQUIRED_WORDS = /\b(mandatory|required|must attend|attendance (is )?(taken|required))\b/i;
const OPTIONAL_WORDS = /\b(optional|open to all|all (are )?welcome|voluntary|if you can|drop-?in)\b/i;

/** The same title however it is dated or numbered, so one choice covers a weekly meeting. */
function titleKey(title) {
  return String(title || '').toLowerCase()
    .replace(/#\s*\d+|\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
}

/** "ECO112 — Supply and Demand" and "Intl Politics — Realism I" both have a course in front. */
function coursePrefix(title) {
  const s = String(title || '');
  let m = /^\s*([A-Z]{1,5})[\s-]?(\d{2,3}[A-Z]?)\s*[—–:-]\s+/.exec(s);
  if (m) return `${m[1]} ${m[2]}`;
  m = /^\s*(.{2,40}?)\s+[—–]\s+\S/.exec(s);
  return m && m[1].split(/\s+/).length <= 4 ? m[1].trim() : '';
}

/** Which of your groups an entry belongs to: its name or short name, as a whole word. */
function groupFor(text, groups) {
  for (const g of groups || []) {
    for (const n of [g.name, ...(g.aliases || [])]) {
      if (!n || n.length < 2) continue;
      const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // A short name in capitals only matches in capitals: SAAC, not "saac" inside a word.
      const re = /^[A-Z0-9&]+$/.test(n) ? new RegExp(`(^|[^A-Za-z0-9])${esc}([^A-Za-z0-9]|$)`) : new RegExp(`(^|[^a-z0-9])${esc.toLowerCase()}([^a-z0-9]|$)`);
      if (re.test(/^[A-Z0-9&]+$/.test(n) ? text : text.toLowerCase())) return g;
    }
  }
  return null;
}

/**
 * The label for one entry.
 *
 * ev: { title, calendar, location, isDeadline }
 * ctx: { groups: joined groups, courses: Set of course names seen more than
 *        once, overrides: { titleKey: { type?, attend? } } }
 * Returns { type, name, attend, group, by } where by is 'you' when overruled.
 */
function classify(ev, ctx = {}) {
  const title = String(ev.title || '');
  const calendar = String(ev.calendar || '');
  const text = `${title} ${ev.location || ''}`;
  const group = groupFor(title, ctx.groups);

  let type = null;
  if (/holiday/i.test(calendar)) type = 'holiday';
  if (!type) {
    for (const [t, re] of RULES) if (re.test(title)) { type = t; break; }
  }
  // "Review: Midterm I prep" is getting ready for the exam, not the exam.
  if (type === 'exam' && /\b(prep|review|study)\b/i.test(title)) type = 'review';
  const course = coursePrefix(title);
  const isCourse = !group && (COURSE_CODE.test(course) || (course && ctx.courses && ctx.courses.has(course.toLowerCase())));
  // A session of a course is a class, unless it is the exam or office hours.
  if (isCourse && (!type || ['review', 'social', 'game', 'meeting', 'work', 'travel'].includes(type))) type = 'class';
  if (!type && group) type = group.kind === 'team' ? 'practice' : 'meeting';
  if (!type) type = 'event';

  let attend = TYPES[type].attend;
  if (type !== 'holiday') {
    if (OPTIONAL_WORDS.test(text)) attend = 'optional';
    else if (REQUIRED_WORDS.test(text)) attend = 'required';
    else if (group && type === 'meeting' && group.attend) attend = group.attend;
  }

  const label = { type, name: TYPES[type].name, attend, group: group ? group.name : null, course: isCourse ? course : null, by: 'auto' };
  const o = (ctx.overrides || {})[titleKey(title)];
  if (o) {
    if (o.type && TYPES[o.type]) { label.type = o.type; label.name = TYPES[o.type].name; }
    if (o.attend !== undefined) label.attend = ATTEND.includes(o.attend) ? o.attend : null;
    label.by = 'you';
  }
  return label;
}

/** Course names that start more than one entry in a stretch of calendar. */
function coursesIn(titles) {
  const count = new Map();
  for (const t of titles) {
    const c = coursePrefix(t).toLowerCase();
    if (c) count.set(c, (count.get(c) || 0) + 1);
  }
  return new Set([...count.entries()].filter(([, n]) => n >= 2).map(([c]) => c));
}

module.exports = { TYPES, ATTEND, RULES, classify, coursesIn, coursePrefix, groupFor, titleKey };
