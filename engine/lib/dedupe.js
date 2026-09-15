'use strict';
/**
 * dedupe.js - telling when two things Mellow captured are the same thing.
 *
 * The same assignment can arrive three ways: a course calendar ("ECO112 —
 * Homework 1"), the reader's cleaner version of the same entry ("Homework 1",
 * course ECO 112), and a syllabus dropped into Files ("Homework 1 due"). Each
 * gets its own key, so without this they show up three times.
 *
 * Two deadlines are the same when they are due the same day, are the same kind
 * (homework or exam), belong to the same class, and name the same thing. When
 * in doubt they are kept apart: two separate reminders are an annoyance, one
 * missing assignment is a problem.
 */

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'due', 'your', 'you', 'on', 'at', 'in', 'of', 'to', 'by']);
// "ECO 112", "ECO112", "DAN-119-1". The letters and number say which class.
const CODE = /\b([a-z]{2,5})[\s-]?(\d{3,4})[a-z]?(?:-\d{1,2})?\b/gi;

/** "ECO112 â€” Homework 1" was saved with its dash mangled; read it back as UTF-8. */
function repairText(s) {
  const t = String(s == null ? '' : s);
  if (!/[ÂÃâ][\u0080-\u00bf€™œ]/.test(t)) return t;
  try {
    const fixed = Buffer.from(t, 'latin1').toString('utf8');
    return fixed.includes('\ufffd') ? t.replace(/â€”/g, '—').replace(/â€“/g, '–').replace(/â€™/g, '’') : fixed;
  } catch (_) {
    return t;
  }
}

function codes(s) {
  const out = new Set();
  String(s || '').replace(CODE, (m, letters, num) => { out.add(`${letters.toUpperCase()}${num}`); return m; });
  return out;
}

function withoutCodes(s) {
  return String(s || '').replace(CODE, ' ');
}

function words(s) {
  return new Set(withoutCodes(repairText(s)).toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/)
    .filter((w) => (w.length >= 2 || /\d/.test(w)) && !STOP.has(w)));
}

function numbers(s) {
  return (withoutCodes(s).match(/\d+/g) || []).map(Number).sort((a, b) => a - b).join(',');
}

/** Two titles name the same thing: one holds the other, or most of the shorter one's words are shared. */
function sameThing(a, b) {
  const plain = (s) => withoutCodes(repairText(s)).toLowerCase().replace(/\bdue\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const na = plain(a), nb = plain(b);
  if (!na || !nb) {
    const fa = String(a || '').toLowerCase().replace(/[^a-z0-9]+/g, ''), fb = String(b || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    return !!fa && fa === fb;
  }
  const numA = numbers(repairText(a)), numB = numbers(repairText(b));
  if (numA && numB && numA !== numB) return false;
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  const wa = words(a), wb = words(b);
  const small = wa.size <= wb.size ? wa : wb;
  const big = small === wa ? wb : wa;
  if (!small.size) return false;
  let shared = 0;
  for (const w of small) if (big.has(w)) shared++;
  return shared / small.size >= 0.6 && shared >= Math.min(2, small.size);
}

/**
 * What an item says about its class: course codes, or a course name like
 * "Intl Politics" when there is no code. Empty when it says nothing.
 */
function courseInfo(item) {
  const c = codes(`${item.course || ''} ${item.title || ''}`);
  const name = item.course && !codes(item.course).size ? String(item.course).toLowerCase().replace(/[^a-z0-9]+/g, '') : '';
  return { codes: c, name };
}

/** Same class, or one of them doesn't say. Two different classes never match. */
function sameCourse(a, b) {
  const ia = courseInfo(a), ib = courseInfo(b);
  const aSays = ia.codes.size || ia.name, bSays = ib.codes.size || ib.name;
  if (!aSays || !bSays) return true;
  for (const c of ia.codes) if (ib.codes.has(c)) return true;
  const titleA = String(a.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const titleB = String(b.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (ia.name && (ia.name === ib.name || titleB.includes(ia.name))) return true;
  if (ib.name && titleA.includes(ib.name)) return true;
  return false;
}

/** Shares a course code: the strongest sign two class meetings at the same time are one. */
function shareCode(a, b) {
  const ia = courseInfo(a), ib = courseInfo(b);
  for (const c of ia.codes) if (ib.codes.has(c)) return true;
  return !!(ia.name && ib.name && ia.name === ib.name);
}

function localDay(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function sameAssignment(a, b) {
  if ((a.kind === 'exam') !== (b.kind === 'exam')) return false;
  if ((a.group || 'school') !== (b.group || 'school')) return false;
  const da = localDay(a.dueAt);
  if (!da || da !== localDay(b.dueAt)) return false;
  return sameCourse(a, b) && sameThing(a.title, b.title);
}

/** How good a title is to show: readable, no course code in front, no "due" on the end. */
function titleScore(item) {
  const t = String(item.title || '');
  let score = 0;
  if (t !== repairText(t)) score -= 40;
  if (codes(t).size) score -= 15;
  if (/\bdue\b/i.test(t)) score -= 10;
  if (/^[A-Z0-9\s\W]{8,}$/.test(t)) score -= 10;
  if (item.course) score += 5;
  if (/[A-Z]{2,5} \d{3,4}/.test(item.course || '')) score += 3;
  return score - t.length / 20;
}

/**
 * Collapses duplicate homework and exams in the saved state. One entry of each
 * group is kept: the one you marked done if any, then one you confirmed, then
 * one from your calendar or email rather than a file. It takes the best title,
 * every source, and your confirmation. The others are set aside with
 * `mergedInto` pointing at it; nothing is deleted.
 *
 * `doneKeys` is the set of task ids with a completion or pass in history.
 * Returns { merged, repaired }: entries set aside, and titles with a mangled
 * dash put right.
 */
function dedupeHomework(state, doneKeys = new Set(), now = new Date()) {
  const live = Object.values(state.homework || {}).filter((h) => h && !h.dismissed);
  let repaired = 0;
  for (const h of live) {
    // "Homework 9 due": the date already says it's due.
    const fixed = repairText(h.title).replace(/^(.{3,}?)\s+due$/i, '$1');
    if (fixed !== h.title) { h.title = fixed; repaired++; }
  }

  const groups = [];
  for (const item of live) {
    const g = groups.find((members) => members.every((m) => sameAssignment(m, item)));
    if (g) g.push(item); else groups.push([item]);
  }

  let merged = 0;
  for (const g of groups) {
    if (g.length < 2) continue;
    const rank = (h) => (doneKeys.has(h.key) ? 1000 : 0) + (h.confirmed ? 100 : 0) +
      ((h.dueFrom || {}).type === 'calendar' ? 20 : (h.dueFrom || {}).type === 'email' ? 10 : 0) +
      (String(h.key).startsWith('hw:') ? 5 : 0);
    const keep = g.slice().sort((a, b) => rank(b) - rank(a))[0];
    const best = g.slice().sort((a, b) => titleScore(b) - titleScore(a))[0];
    keep.title = best.title;
    if (best.course) keep.course = best.course;
    keep.confirmed = g.some((h) => h.confirmed);
    const sources = [];
    for (const h of g) {
      for (const s of h.sources || []) {
        if (!sources.some((x) => x.type === s.type && x.ref === s.ref)) sources.push(s);
      }
    }
    keep.sources = sources.slice(-10);
    // The calendar is the system of record for when something is due.
    const fromCalendar = g.find((h) => (h.dueFrom || {}).type === 'calendar');
    if (fromCalendar && (keep.dueFrom || {}).type !== 'calendar') {
      keep.dueAt = fromCalendar.dueAt;
      keep.hasTime = fromCalendar.hasTime;
      keep.dueFrom = fromCalendar.dueFrom;
    }
    for (const h of g) {
      if (h === keep) continue;
      h.dismissed = true;
      h.mergedInto = keep.key;
      h.mergedAt = now.toISOString();
      merged++;
    }
  }
  return { merged, repaired };
}

/** "13:15", in local time, or null for an all-day item. */
function localTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.getHours() * 60 + d.getMinutes();
}

/**
 * A meeting you added from a file or the assistant that your Google or .ics
 * calendar already has: it starts within fifteen minutes of one there, and
 * they share a course code or a title.
 */
function coveredBy(event, others) {
  const s = new Date(event.start).getTime();
  if (Number.isNaN(s)) return null;
  return others.find((o) => {
    const os = new Date(o.start).getTime();
    if (Number.isNaN(os) || Math.abs(os - s) > 15 * 60000) return false;
    if (!!o.allDay !== !!event.allDay) return false;
    return shareCode(event, o) || sameThing(event.title, o.title);
  }) || null;
}

module.exports = { repairText, codes, sameThing, sameCourse, shareCode, sameAssignment, dedupeHomework, coveredBy, localTime, titleScore };
