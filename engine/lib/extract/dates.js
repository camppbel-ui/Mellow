'use strict';
/**
 * dates.js - find the due date in a piece of email text.
 *
 * An email is full of dates that are not deadlines: when it was sent, the
 * quoted reply header, the date a grade was posted. So this does not return
 * the first date it sees. It finds every date, then keeps the one sitting
 * closest to a word like "due", "deadline" or "submit". A date with no such
 * word near it is not treated as a deadline at all.
 *
 * Times with no timezone are read as local time. The US abbreviations Canvas
 * and most university systems print - CDT, EST and so on - are honoured.
 */

const MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

const WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

// Offsets in minutes east of UTC.
const ZONES = {
  EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420,
};

// "turn it in", "turn this in", "turned the essay in" - one word allowed between.
const DUE_WORDS = /\b(due|deadline|submit|submission|turn(?:ed)?\s+(?:\w+\s+)?in|hand\s+(?:\w+\s+)?in|closes|close[sd]?\s+at|no\s+later\s+than|by)\b/gi;

const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const WEEKDAY_NAMES = Object.keys(WEEKDAYS).join('|');

/**
 * Cut the quoted history off a reply. "On Mon, Sep 8, 2026 at 3:14 PM Prof
 * wrote:" is a date sitting near the word "at", and everything under it is an
 * older conversation whose deadlines may already have moved.
 */
function stripQuoted(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^\s*On .{6,120}wrote:\s*$/i.test(line)) break;
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^\s*From:\s.+/i.test(line) && out.length > 3) break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

function atLocal(y, mo, d, h, mi) {
  return new Date(y, mo, d, h, mi, 0, 0);
}

function atZone(y, mo, d, h, mi, offsetMinutes) {
  return new Date(Date.UTC(y, mo, d, h, mi, 0, 0) - offsetMinutes * 60000);
}

/**
 * A month and day with no year means the nearest one: an assignment "due
 * Jan 12" read in December is next month, not eleven months ago.
 */
function inferYear(month, day, reference) {
  const y = reference.getFullYear();
  const candidate = new Date(y, month, day);
  const days = (candidate - reference) / 86400000;
  if (days < -60) return y + 1;
  if (days > 300) return y - 1;
  return y;
}

/**
 * Look just after (then just before) a date for a time: "at 11:59pm",
 * "11:59 PM CDT", "by 5pm", "noon", "midnight".
 */
function findTime(text, start, end) {
  const after = text.slice(end, end + 32);
  const before = text.slice(Math.max(0, start - 24), start);

  const tryMatch = (s) => {
    let m = /\b(noon)\b/i.exec(s);
    if (m) return { h: 12, mi: 0, zone: null };
    m = /\b(midnight)\b/i.exec(s);
    // "Due Friday at midnight" means the end of Friday, which is how every
    // student reads it and how every course site enforces it.
    if (m) return { h: 23, mi: 59, zone: null };

    m = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?:\s*\(?\b(EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b\)?)?/i.exec(s);
    if (m) {
      let h = parseInt(m[1], 10) % 12;
      if (/^p/i.test(m[3])) h += 12;
      const mi = m[2] ? parseInt(m[2], 10) : 0;
      if (h > 23 || mi > 59) return null;
      return { h, mi, zone: m[4] ? m[4].toUpperCase() : null };
    }

    m = /\b([01]?\d|2[0-3]):([0-5]\d)(?:\s*\(?\b(EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b\)?)?/i.exec(s);
    if (m) return { h: parseInt(m[1], 10), mi: parseInt(m[2], 10), zone: m[3] ? m[3].toUpperCase() : null };
    return null;
  };

  return tryMatch(after) || tryMatch(before);
}

function build(y, mo, d, time) {
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  const t = time || { h: 23, mi: 59, zone: null };
  const date = t.zone && ZONES[t.zone] !== undefined
    ? atZone(y, mo, d, t.h, t.mi, ZONES[t.zone])
    : atLocal(y, mo, d, t.h, t.mi);
  // Rejects Feb 30 and friends, which Date would otherwise roll into March.
  const check = t.zone ? new Date(Date.UTC(y, mo, d)) : date;
  if ((t.zone ? check.getUTCDate() : check.getDate()) !== d) return null;
  return { date, hasTime: !!time };
}

/**
 * Every date-shaped thing in the text, with where it sits.
 */
function findDates(text, reference) {
  const found = [];
  const push = (index, length, result) => {
    if (result) found.push({ index, length, ...result });
  };

  // "September 15", "Sep. 15th, 2026", "Fri, Sep 15"
  const monthRe = new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi');
  let m;
  while ((m = monthRe.exec(text))) {
    const month = MONTHS[m[1].toLowerCase()];
    const day = parseInt(m[2], 10);
    const year = m[3] ? parseInt(m[3], 10) : inferYear(month, day, reference);
    const time = findTime(text, m.index, m.index + m[0].length);
    push(m.index, m[0].length, build(year, month, day, time));
  }

  // "15 September" - less common in the US but universities send it
  const dayFirstRe = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_NAMES})\\b(?:,?\\s+(\\d{4}))?`, 'gi');
  while ((m = dayFirstRe.exec(text))) {
    const month = MONTHS[m[2].toLowerCase()];
    const day = parseInt(m[1], 10);
    const year = m[3] ? parseInt(m[3], 10) : inferYear(month, day, reference);
    const time = findTime(text, m.index, m.index + m[0].length);
    push(m.index, m[0].length, build(year, month, day, time));
  }

  // "2026-09-15"
  const isoRe = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = isoRe.exec(text))) {
    const time = findTime(text, m.index, m.index + m[0].length);
    push(m.index, m[0].length, build(+m[1], +m[2] - 1, +m[3], time));
  }

  // "9/15" or "9/15/2026" - US month-first, which is what a US school sends.
  // Not preceded or followed by another digit or slash, so "3/4 of the class"
  // style fractions inside longer numbers are left alone.
  const slashRe = /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?(?![\d/])/g;
  while ((m = slashRe.exec(text))) {
    const month = parseInt(m[1], 10) - 1;
    const day = parseInt(m[2], 10);
    if (month > 11 || day > 31) continue;
    let year = m[3] ? parseInt(m[3], 10) : inferYear(month, day, reference);
    if (year < 100) year += 2000;
    const time = findTime(text, m.index, m.index + m[0].length);
    push(m.index, m[0].length, build(year, month, day, time));
  }

  // "today", "tonight", "tomorrow"
  const relRe = /\b(today|tonight|tomorrow)\b/gi;
  while ((m = relRe.exec(text))) {
    const word = m[1].toLowerCase();
    const base = new Date(reference);
    if (word === 'tomorrow') base.setDate(base.getDate() + 1);
    const time = findTime(text, m.index, m.index + m[0].length);
    push(m.index, m[0].length, build(base.getFullYear(), base.getMonth(), base.getDate(), time));
  }

  // "Friday", "next Friday", "this Friday"
  const wdRe = new RegExp(`\\b(next\\s+|this\\s+)?(${WEEKDAY_NAMES})\\b`, 'gi');
  while ((m = wdRe.exec(text))) {
    // A weekday already part of "Friday, September 15" was handled above.
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 16);
    if (new RegExp(`^,?\\s*(${MONTH_NAMES})\\b`, 'i').test(tail) || /^,?\s*\d{1,2}\//.test(tail)) continue;

    const target = WEEKDAYS[m[2].toLowerCase()];
    const base = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate());
    let add = (target - base.getDay() + 7) % 7;
    // "next Friday" is the Friday of next week, which is how people use it.
    if (m[1] && /next/i.test(m[1])) add += 7;
    base.setDate(base.getDate() + add);
    const time = findTime(text, m.index, m.index + m[0].length);
    push(m.index, m[0].length, build(base.getFullYear(), base.getMonth(), base.getDate(), time));
  }

  return found.sort((a, b) => a.index - b.index);
}

/**
 * The due date in this text, or null if nothing reads as one.
 *
 * `window` is how far, in characters, a date may sit from a due-word and still
 * count. Subject lines are short and pass `Infinity`, because "HW 3 - Friday"
 * has no due-word but is still obviously a deadline.
 */
function findDueDate(text, reference = new Date(), options = {}) {
  const body = options.keepQuoted ? String(text || '') : stripQuoted(text || '');
  const window = options.window === undefined ? 80 : options.window;
  const dates = findDates(body, reference);
  if (!dates.length) return null;

  const dueWords = [];
  let m;
  DUE_WORDS.lastIndex = 0;
  while ((m = DUE_WORDS.exec(body))) dueWords.push(m.index);

  let best = null;
  for (const d of dates) {
    let distance = Infinity;
    for (const w of dueWords) {
      // A due-word before the date is the usual phrasing ("due Sep 15");
      // after it is weaker ("Sep 15 is the deadline"), so it costs a little.
      const gap = w <= d.index ? d.index - w : (w - (d.index + d.length)) + 10;
      if (gap >= 0 && gap < distance) distance = gap;
    }
    if (window !== Infinity && distance > window) continue;
    if (!best || distance < best.distance || (distance === best.distance && d.hasTime && !best.hasTime)) {
      best = { ...d, distance };
    }
  }

  if (!best) return null;
  return {
    date: best.date,
    hasTime: best.hasTime,
    matched: body.slice(best.index, best.index + best.length),
  };
}

module.exports = { findDueDate, findDates, stripQuoted, inferYear, ZONES };
