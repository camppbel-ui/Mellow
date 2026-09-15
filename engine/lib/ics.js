'use strict';
/**
 * ics.js - a small iCalendar parser. No dependencies, same as everything else.
 *
 * Why iCalendar rather than the Google and Microsoft APIs: every calendar
 * system on earth will hand you a secret .ics URL, and fetching one is an HTTPS
 * GET. No OAuth app to register, no client secret to store on the PC, no
 * consent screen to re-approve, and nothing that breaks when a university IT
 * department disallows third-party app registrations. One read-only URL per
 * calendar, and it works the same for a Google account and an Outlook one.
 *
 * What is deliberately not implemented: VTIMEZONE. Properly resolving an
 * arbitrary TZID needs the full tz database. Instead a TZID-qualified time is
 * read as local time, which is correct whenever the calendar's timezone matches
 * the machine's - the normal case for your own schedule - and wrong by an
 * offset if you are reading a calendar kept in another timezone. UTC times,
 * which is what most exports actually emit, are handled exactly.
 */

/**
 * Long iCalendar properties are wrapped across lines, and a continuation is
 * marked by a leading space or tab. Undo that before anything else.
 */
function unfold(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

/** SUMMARY:Bio lab\, room 4 -> the comma and newline escapes come back out. */
function unescapeText(v) {
  return String(v)
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

/**
 * Split "DTSTART;TZID=America/New_York:20260910T090000" into its three parts.
 */
function parseLine(line) {
  const colon = line.indexOf(':');
  if (colon === -1) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(';');
  const name = parts[0].toUpperCase();

  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

/**
 * An iCalendar date, as { date, allDay }.
 *
 * A trailing Z is UTC and is exact. Everything else is read as local time -
 * see the note at the top about VTIMEZONE.
 */
function parseDate(value, params = {}) {
  const v = String(value).trim();

  // 20260910 - a whole day, with no time at all.
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly || params.VALUE === 'DATE') {
    const m = dateOnly || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { date: new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0), allDay: true };
  }

  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;

  if (m[7] === 'Z') {
    return { date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])), allDay: false };
  }
  return { date: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), allDay: false };
}

/** FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261215T050000Z -> an object. */
function parseRRule(value) {
  const out = {};
  for (const pair of String(value).split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    out[pair.slice(0, eq).toUpperCase()] = pair.slice(eq + 1);
  }
  return out;
}

const DAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function sameClock(from, day) {
  const out = new Date(day);
  out.setHours(from.getHours(), from.getMinutes(), from.getSeconds(), 0);
  return out;
}

/**
 * Expand one recurring event across [rangeStart, rangeEnd].
 *
 * Only DAILY and WEEKLY are expanded, which is what a class timetable is. A
 * MONTHLY or YEARLY rule yields its first occurrence and nothing more, rather
 * than silently producing wrong dates.
 */
function expandRecurrence(event, rule, rangeStart, rangeEnd, exdates) {
  const out = [];
  const freq = String(rule.FREQ || '').toUpperCase();
  const interval = Math.max(1, parseInt(rule.INTERVAL, 10) || 1);
  const durationMs = event.end.getTime() - event.start.getTime();

  let until = null;
  if (rule.UNTIL) {
    const u = parseDate(rule.UNTIL);
    if (u) until = u.date;
  }
  const count = rule.COUNT ? parseInt(rule.COUNT, 10) : null;

  const stop = until && until < rangeEnd ? until : rangeEnd;
  const skip = new Set(exdates.map((d) => d.getTime()));

  const push = (start) => {
    if (skip.has(start.getTime())) return true;
    if (start > stop) return false;
    if (start >= rangeStart) {
      out.push({ ...event, start, end: new Date(start.getTime() + durationMs), recurring: true });
    }
    return true;
  };

  if (freq === 'DAILY') {
    let cursor = new Date(event.start);
    let made = 0;
    // A hard iteration cap: a malformed rule must not spin forever.
    for (let i = 0; i < 4000 && cursor <= stop; i++) {
      if (!push(new Date(cursor))) break;
      made++;
      if (count && made >= count) break;
      cursor = addDays(cursor, interval);
    }
    return out;
  }

  if (freq === 'WEEKLY') {
    const days = rule.BYDAY
      ? String(rule.BYDAY).split(',').map((d) => DAY_CODES[d.trim().slice(-2).toUpperCase()])
          .filter((n) => n !== undefined)
      : [event.start.getDay()];

    // Start from the Sunday of the first week, then step whole weeks.
    let weekStart = addDays(event.start, -event.start.getDay());
    let made = 0;
    for (let w = 0; w < 600; w++) {
      if (weekStart > stop) break;
      for (const dow of days.slice().sort((a, b) => a - b)) {
        const occurrence = sameClock(event.start, addDays(weekStart, dow));
        if (occurrence < event.start) continue;
        if (occurrence > stop) break;
        if (!skip.has(occurrence.getTime())) {
          if (occurrence >= rangeStart) {
            out.push({
              ...event,
              start: occurrence,
              end: new Date(occurrence.getTime() + durationMs),
              recurring: true,
            });
          }
          made++;
          if (count && made >= count) return out;
        }
      }
      weekStart = addDays(weekStart, 7 * interval);
    }
    return out;
  }

  // Anything else: the original occurrence only. Better a missing repeat than
  // a confidently wrong one.
  if (event.start >= rangeStart && event.start <= rangeEnd) out.push({ ...event });
  return out;
}

/**
 * Parse an .ics document into events falling inside [rangeStart, rangeEnd].
 */
function parseIcs(text, rangeStart, rangeEnd, source = {}) {
  const lines = unfold(text).split('\n');
  const events = [];

  let current = null;
  let inEvent = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      current = { exdates: [], rrule: null };
      continue;
    }

    if (line === 'END:VEVENT') {
      inEvent = false;
      if (current && current.start) {
        // A DTSTART with no DTEND is a point in time; give it zero length
        // rather than dropping it.
        if (!current.end) current.end = new Date(current.start);

        const base = {
          uid: current.uid || '',
          title: current.title || '(no title)',
          location: current.location || '',
          start: current.start,
          end: current.end,
          allDay: !!current.allDay,
          status: current.status || '',
          calendar: source.name || 'Calendar',
          calendarId: source.id || '',
          color: source.color || null,
        };

        if (current.rrule) {
          events.push(...expandRecurrence(base, current.rrule, rangeStart, rangeEnd, current.exdates));
        } else if (base.end >= rangeStart && base.start <= rangeEnd) {
          events.push(base);
        }
      }
      current = null;
      continue;
    }

    if (!inEvent || !current) continue;

    const p = parseLine(line);
    if (!p) continue;

    switch (p.name) {
      case 'UID': current.uid = p.value; break;
      case 'SUMMARY': current.title = unescapeText(p.value); break;
      case 'LOCATION': current.location = unescapeText(p.value); break;
      case 'STATUS': current.status = p.value; break;
      case 'DTSTART': {
        const d = parseDate(p.value, p.params);
        if (d) { current.start = d.date; current.allDay = d.allDay; }
        break;
      }
      case 'DTEND': {
        const d = parseDate(p.value, p.params);
        if (d) current.end = d.date;
        break;
      }
      case 'RRULE': current.rrule = parseRRule(p.value); break;
      case 'EXDATE': {
        for (const one of String(p.value).split(',')) {
          const d = parseDate(one, p.params);
          if (d) current.exdates.push(d.date);
        }
        break;
      }
      default: break;
    }
  }

  // Cancelled instances are still in the file; nobody wants to see them.
  return events
    .filter((e) => String(e.status).toUpperCase() !== 'CANCELLED')
    .sort((a, b) => a.start - b.start);
}

module.exports = {
  parseIcs, parseDate, parseRRule, unfold, unescapeText, parseLine, expandRecurrence,
};
