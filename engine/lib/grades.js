'use strict';
/**
 * grades.js - your courses, how each one is graded, and every score you get
 * back, with where that leaves you.
 *
 * A course is weighted by categories (Exams 40%, Homework 25%, ...), usually
 * straight from its syllabus: drop the syllabus in Files and the grading
 * breakdown comes with it. Scores are typed in on the Grades page, told to the
 * assistant, or read from a screenshot of a grades page you drop.
 *
 * From those, each course gets a current percentage and letter, the lowest and
 * highest it can still finish at, and what you need on the work that's left to
 * reach the grade you're aiming for. Credits turn the letters into a GPA.
 *
 * Kept in grades.json next to health.json, as plain readable JSON.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// RATCHET_DATA_DIR lets a test server use a scratch copy instead of yours.
const ROOT = process.env.RATCHET_DATA_DIR || path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'grades.json');

// The usual US scale. A syllabus with its own cut-offs replaces it for that course.
const DEFAULT_SCALE = [
  { letter: 'A', min: 93 }, { letter: 'A-', min: 90 },
  { letter: 'B+', min: 87 }, { letter: 'B', min: 83 }, { letter: 'B-', min: 80 },
  { letter: 'C+', min: 77 }, { letter: 'C', min: 73 }, { letter: 'C-', min: 70 },
  { letter: 'D+', min: 67 }, { letter: 'D', min: 63 }, { letter: 'D-', min: 60 },
  { letter: 'F', min: 0 },
];
const GPA_POINTS = { 'A+': 4, A: 4, 'A-': 3.7, 'B+': 3.3, B: 3, 'B-': 2.7, 'C+': 2.3, C: 2, 'C-': 1.7, 'D+': 1.3, D: 1, 'D-': 0.7, F: 0 };
const SOURCES = ['manual', 'assistant', 'file'];

const DEFAULT_SETTINGS = {
  term: '',
  defaultTarget: 'A-',
  shareWithAi: true,
};

/* --------------------------------- storage ------------------------------- */

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { return fallback; }
}

function load() {
  const raw = readJson(DATA_FILE, {});
  return {
    _comment: raw._comment || 'Your courses and grades, from the Grades page. Safe to edit by hand while the engine runs.',
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    courses: Array.isArray(raw.courses) ? raw.courses.filter((c) => c && c.id).map(normalizeCourse) : [],
  };
}

function save(data) {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

/** Load, change, save. Node runs this start to finish, so two requests cannot interleave. */
function change(fn) {
  const data = load();
  const result = fn(data);
  save(data);
  return result;
}

function normalizeCourse(c) {
  return {
    ...c,
    categories: Array.isArray(c.categories) ? c.categories.filter((k) => k && k.id) : [],
    grades: Array.isArray(c.grades) ? c.grades.filter((g) => g && g.id) : [],
    scale: Array.isArray(c.scale) && c.scale.length ? c.scale : null,
  };
}

/* -------------------------------- validation ----------------------------- */

const newId = (prefix) => `${prefix}-${crypto.randomBytes(5).toString('hex')}`;
const round = (n, places = 1) => Math.round(n * 10 ** places) / 10 ** places;

function cleanStr(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanNum(v, { min = 0, max = 1e6, what = 'That' } = {}) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[,%\s]/g, ''));
  if (!Number.isFinite(n)) throw new Error(`${what} should be a number.`);
  if (n < min || n > max) throw new Error(`${what} should be between ${min} and ${max}.`);
  return round(n, 2);
}
function cleanDay(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error('The date should look like 2026-09-15.');
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (d.getMonth() !== +m[2] - 1) throw new Error('That date does not exist.');
  return s;
}
function cleanLetter(v) {
  const s = String(v || '').trim().toUpperCase().replace(/\s+/g, '');
  return GPA_POINTS[s] != null ? s : '';
}

/** "eco112", "ECO-112" and "ECO 112" are the same course. */
function codeKey(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Every code a course goes by, without its section: "GOV 113-2" and
 * "ECO112.1" are GOV 113 and ECO 112, and a cross-listed "AFR/DAN 119" is both
 * AFR 119 and DAN 119. Anything else is just its code.
 */
function courseKeys(s) {
  const m = /^\s*([A-Z]{2,5}(?:\s*\/\s*[A-Z]{2,5})*)\s*-?\s*(\d{2,4}[A-Z]?)(?![0-9])/i.exec(String(s || ''));
  if (!m) { const k = codeKey(s); return k ? [k] : []; }
  return m[1].toUpperCase().split('/').map((p) => p.trim() + m[2].toUpperCase());
}

function sameCourse(a, b) {
  const ka = courseKeys(a), kb = courseKeys(b);
  return ka.some((k) => kb.includes(k));
}

function cleanScale(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const row of list) {
    const letter = cleanLetter(row && row.letter);
    const min = Number(row && row.min);
    if (!letter || !Number.isFinite(min) || min < 0 || min > 100) continue;
    if (out.some((r) => r.letter === letter)) continue;
    out.push({ letter, min: round(min, 2) });
  }
  if (out.length < 2) return null;
  out.sort((a, b) => b.min - a.min);
  // Whatever falls below the lowest cut-off is an F.
  if (out[out.length - 1].min > 0 && !out.some((r) => r.letter === 'F')) out.push({ letter: 'F', min: 0 });
  return out;
}

function cleanCategories(list, existing = []) {
  if (!Array.isArray(list)) return existing;
  const out = [];
  for (const k of list.slice(0, 20)) {
    const name = cleanStr(k && k.name, 60);
    if (!name) continue;
    const weight = cleanNum(k.weight, { min: 0, max: 100, what: `${name}'s weight` });
    const drop = Math.max(0, Math.min(20, Math.round(Number(k.drop) || 0)));
    // How many there will be (3 exams, 10 problem sets). Unknown is null, and then a part with any score counts as done.
    const count = Math.round(Number(k.count)) > 0 ? Math.min(100, Math.round(Number(k.count))) : null;
    // Keep a category's id when it is only renamed or reweighted, so its grades stay in it.
    const same = existing.find((e) => (k.id && e.id === k.id) || nameKey(e.name) === nameKey(name));
    out.push({ id: same ? same.id : newId('k'), name, weight: weight == null ? 0 : weight, drop, count });
  }
  return out;
}

const nameKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(es|s)$/, '');

/* --------------------------------- courses ------------------------------- */

function findCourse(data, ref) {
  const want = String(ref || '').trim();
  if (!want) return null;
  const key = codeKey(want);
  return data.courses.find((c) => c.id === want)
    || data.courses.find((c) => key && codeKey(c.code) === key)
    || data.courses.find((c) => c.code && sameCourse(c.code, want))
    || data.courses.find((c) => c.name && c.name.toLowerCase() === want.toLowerCase())
    // "ECO 112 Macro" or "Macroeconomics" still find ECO 112, but MATH 101 never finds MATH 10, nor BIO 101L BIO 101.
    || data.courses.find((c) => {
      const chars = String(c.code || '').replace(/[^A-Za-z0-9]/g, '').split('');
      if (chars.length >= 4 && new RegExp(`^${chars.join('[^A-Za-z0-9]*')}(?![A-Za-z0-9])`, 'i').test(want)) return true;
      return !!(c.name && want.length >= 5 && c.name.toLowerCase().includes(want.toLowerCase()));
    })
    || null;
}

function upsertCourse(data, input) {
  if (!input || typeof input !== 'object') throw new Error('Nothing to save.');
  const existing = input.id ? data.courses.find((c) => c.id === input.id) : null;
  if (input.id && !existing) throw new Error('That course is no longer there.');
  const code = cleanStr(input.code != null ? input.code : existing && existing.code, 24).toUpperCase();
  const name = cleanStr(input.name != null ? input.name : existing && existing.name, 90);
  if (!code && !name) throw new Error('Give the course a code or a name, like ECO 112.');
  const clash = code && data.courses.find((c) => c !== existing && codeKey(c.code) === codeKey(code));
  if (clash) throw new Error(`${clash.code} is already in Grades.`);
  const credits = input.credits !== undefined ? cleanNum(input.credits, { min: 0, max: 12, what: 'Credits' }) : existing ? existing.credits : null;
  const target = input.target !== undefined ? cleanLetter(input.target) : existing ? existing.target : '';
  const now = new Date().toISOString();
  const course = {
    id: existing ? existing.id : newId('c'),
    code, name,
    credits: credits == null ? (existing ? existing.credits : 3) : credits,
    target: target || '',
    term: cleanStr(input.term != null ? input.term : existing ? existing.term : data.settings.term, 40),
    instructor: cleanStr(input.instructor != null ? input.instructor : existing && existing.instructor, 80),
    categories: input.categories !== undefined ? cleanCategories(input.categories, existing ? existing.categories : []) : existing ? existing.categories : [],
    scale: input.scale !== undefined ? cleanScale(input.scale) : existing ? existing.scale : null,
    grades: existing ? existing.grades : [],
    archived: input.archived !== undefined ? input.archived === true : !!(existing && existing.archived),
    source: existing ? existing.source || null : input.source || null,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };
  // A grade whose category was removed waits, uncounted, until it is given another.
  const ids = new Set(course.categories.map((k) => k.id));
  course.grades = course.grades.map((g) => (g.category && !ids.has(g.category) ? { ...g, category: null } : g));
  if (existing) data.courses[data.courses.indexOf(existing)] = course; else data.courses.push(course);
  return course;
}

function removeCourse(data, id) {
  const i = data.courses.findIndex((c) => c.id === id);
  if (i < 0) throw new Error('That course is already gone.');
  data.courses.splice(i, 1);
}

/* --------------------------------- grades -------------------------------- */

// Words that say which category a score belongs in when nobody said.
const CATEGORY_HINTS = [
  [/\b(midterm|final|exam|test|prelim)s?\b/i, /exam|test|midterm|final/i],
  [/\bquiz(zes)?\b/i, /quiz/i],
  [/\b(hw|homework|problem ?sets?|psets?|assignments?|worksheets?)\b/i, /homework|problem|assign|pset|exercise/i],
  [/\blabs?\b/i, /lab/i],
  [/\b(essay|paper|report|writing|response)s?\b/i, /paper|essay|writ|report/i],
  [/\bprojects?\b/i, /project/i],
  [/\b(participation|attendance|discussion|clicker|forum)s?\b/i, /particip|attend|discuss|engage/i],
  [/\b(presentation)s?\b/i, /present/i],
];

function guessCategory(course, title, named) {
  if (!course.categories.length) return null;
  if (named) {
    const k = nameKey(named);
    const hit = course.categories.find((c) => nameKey(c.name) === k)
      || course.categories.find((c) => k && (nameKey(c.name).includes(k) || k.includes(nameKey(c.name))));
    if (hit) return hit.id;
  }
  const text = `${named || ''} ${title || ''}`;
  for (const [inTitle, inCategory] of CATEGORY_HINTS) {
    if (!inTitle.test(text)) continue;
    const hit = course.categories.find((c) => inCategory.test(c.name));
    if (hit) return hit.id;
  }
  return null;
}

/** A score checked and tidied, without saving it. Throws on anything unusable. */
function validateGrade(course, input) {
  const title = cleanStr(input.title, 100);
  if (!title) throw new Error('Name the assignment or exam.');
  let score = cleanNum(input.score, { min: 0, max: 100000, what: 'The score' });
  let outOf = cleanNum(input.outOf, { min: 0, max: 100000, what: 'Out of' });
  if (score == null) throw new Error('Add the score you got.');
  // "87%" or a bare 87 with nothing to be out of is a percentage.
  if (outOf == null || outOf === 0) {
    if (score > 150) throw new Error('Add what it was out of.');
    outOf = 100;
  }
  if (score > outOf * 1.5) throw new Error(`${score} out of ${outOf} looks like a typo.`);
  let category = null;
  if (input.category === 'none') category = null;
  else if (input.category && course.categories.some((k) => k.id === input.category)) category = input.category;
  else category = guessCategory(course, title, input.categoryName || (input.category && !String(input.category).startsWith('k-') ? input.category : ''));
  return {
    id: input.id || newId('g'),
    title, score, outOf, category,
    date: cleanDay(input.date) || '',
    excused: input.excused === true,
    extraCredit: input.extraCredit === true,
    note: cleanStr(input.note, 200),
    source: SOURCES.includes(input.source) ? input.source : 'manual',
    at: new Date().toISOString(),
  };
}

function upsertGrade(data, courseRef, input) {
  const course = findCourse(data, courseRef);
  if (!course) throw new Error('That course isn\'t in Grades.');
  if (!input || typeof input !== 'object') throw new Error('Nothing to save.');
  const existing = input.id ? course.grades.find((g) => g.id === input.id) : null;
  if (input.id && !existing) throw new Error('That grade is no longer there.');
  const grade = validateGrade(course, { ...(existing || {}), ...input });
  if (existing) course.grades[course.grades.indexOf(existing)] = grade; else course.grades.push(grade);
  course.updatedAt = new Date().toISOString();
  return { course, grade };
}

function removeGrade(data, courseRef, id) {
  const course = findCourse(data, courseRef);
  if (!course) throw new Error('That course isn\'t in Grades.');
  const i = course.grades.findIndex((g) => g.id === id);
  if (i < 0) throw new Error('That grade is already gone.');
  course.grades.splice(i, 1);
  course.updatedAt = new Date().toISOString();
}

function setSettings(data, patch) {
  if (!patch || typeof patch !== 'object') return data.settings;
  if (patch.term !== undefined) data.settings.term = cleanStr(patch.term, 40);
  if (patch.defaultTarget !== undefined) data.settings.defaultTarget = cleanLetter(patch.defaultTarget) || DEFAULT_SETTINGS.defaultTarget;
  if (patch.shareWithAi !== undefined) data.settings.shareWithAi = patch.shareWithAi === true;
  return data.settings;
}

/**
 * A grading breakdown read from a syllabus: finds the course by its code, or
 * makes it, and sets its categories and scale. Grades already in a category
 * keep it when the syllabus names the category the same way.
 */
function applyGrading(data, grading, source) {
  if (!grading || !Array.isArray(grading.categories) || !grading.categories.length) throw new Error('That file has no grading breakdown.');
  const ref = grading.course || grading.courseName;
  let course = ref ? findCourse(data, grading.course) || findCourse(data, grading.courseName) : null;
  const created = !course;
  const cats = grading.categories.map((k) => ({ name: k.name, weight: k.weight, drop: k.drop, count: k.count }));
  course = upsertCourse(data, {
    id: course ? course.id : undefined,
    code: course ? undefined : grading.course || '',
    name: course && course.name ? undefined : grading.courseName || '',
    credits: course ? undefined : grading.credits != null ? grading.credits : undefined,
    instructor: course && course.instructor ? undefined : grading.instructor || undefined,
    categories: cats,
    scale: grading.scale && grading.scale.length ? grading.scale : undefined,
    target: course ? undefined : data.settings.defaultTarget,
    source: source || null,
  });
  // Scores filed before the breakdown existed find their categories now.
  course.grades = course.grades.map((g) => (g.category ? g : { ...g, category: guessCategory(course, g.title, '') }));
  return { course, created };
}

/* -------------------------------- the maths ------------------------------ */

function scaleOf(course) {
  return course.scale && course.scale.length ? course.scale : DEFAULT_SCALE;
}

function letterFor(pct, scale) {
  if (pct == null) return '';
  const row = scale.find((r) => pct >= r.min - 1e-9);
  return row ? row.letter : scale[scale.length - 1].letter;
}

function minFor(letter, scale) {
  const row = scale.find((r) => r.letter === letter);
  return row ? row.min : null;
}

/** A category's points, with its lowest N dropped once there are more than N. */
function categoryScore(grades, drop) {
  let list = grades.filter((g) => !g.excused && g.score != null && g.outOf > 0);
  let dropped = 0;
  if (drop > 0 && list.length > drop) {
    const byPct = [...list].filter((g) => !g.extraCredit).sort((a, b) => a.score / a.outOf - b.score / b.outOf);
    const out = new Set(byPct.slice(0, drop).map((g) => g.id));
    dropped = out.size;
    list = list.filter((g) => !out.has(g.id));
  }
  const earned = list.reduce((s, g) => s + g.score, 0);
  const possible = list.filter((g) => !g.extraCredit).reduce((s, g) => s + g.outOf, 0);
  return { count: list.length, dropped, earned, possible, pct: possible > 0 ? (100 * earned) / possible : null };
}

/**
 * Where a course stands: its grade now, the range it can still finish in, and
 * what the target needs.
 *
 * The grade now is weighted the way Canvas shows it: each part with a score
 * counts at its full weight. The range and what the target needs also count
 * how much of each part is done, when it's known how many there will be: one
 * exam of three leaves two thirds of the Exams weight still to come.
 */
function summarize(course, settings = DEFAULT_SETTINGS) {
  const scale = scaleOf(course);
  const graded = course.grades.filter((g) => !g.excused && g.score != null && g.outOf > 0);
  const totalW = course.categories.reduce((s, k) => s + (k.weight || 0), 0);
  const weighted = totalW > 0;
  let percent = null, min = null, max = null;
  let shownW = 0, shownEarned = 0;   // the grade now
  let gradedW = 0, earnedW = 0;      // the share of the grade that is done, and what it earned

  const categories = course.categories.map((k) => {
    const cs = categoryScore(course.grades.filter((g) => g.category === k.id), k.drop || 0);
    const done = k.count ? Math.min(1, (cs.count + cs.dropped) / k.count) : 1;
    if (weighted && cs.pct != null && k.weight > 0) {
      shownW += k.weight; shownEarned += k.weight * cs.pct;
      gradedW += k.weight * done; earnedW += k.weight * done * cs.pct;
    }
    return {
      id: k.id, name: k.name, weight: k.weight, drop: k.drop || 0, expected: k.count || null,
      percent: cs.pct == null ? null : round(cs.pct), count: cs.count, dropped: cs.dropped,
      done: cs.pct == null ? 0 : round(done, 3),
    };
  });

  if (weighted) {
    percent = shownW > 0 ? shownEarned / shownW : null;
    if (gradedW > 0) {
      min = earnedW / totalW;
      max = (earnedW + 100 * (totalW - gradedW)) / totalW;
    }
  } else if (graded.length) {
    const cs = categoryScore(graded, 0);
    percent = cs.pct;
  }

  const target = course.target || settings.defaultTarget || '';
  const targetMin = target ? minFor(target, scale) : null;
  let needed = null;
  if (targetMin != null && weighted) {
    const leftW = totalW - gradedW;
    if (leftW <= 0.0001) {
      needed = { letter: target, percent: null, status: percent != null && percent >= targetMin ? 'made' : 'missed', leftWeight: 0 };
    } else {
      const need = (targetMin * totalW - earnedW) / leftW;
      needed = { letter: target, percent: round(Math.max(0, need)), status: need <= 0 ? 'locked' : need > 100 ? 'out-of-reach' : need > 90 ? 'stretch' : 'on-track', leftWeight: round(leftW) };
    }
  }

  const letter = letterFor(percent == null ? null : round(percent, 2), scale);
  const trend = graded.filter((g) => !g.extraCredit)
    .sort((a, b) => String(a.date || a.at).localeCompare(String(b.date || b.at)))
    .slice(-10).map((g) => round((100 * g.score) / g.outOf));
  const uncategorized = weighted ? graded.filter((g) => !g.category).length : 0;

  return {
    id: course.id, code: course.code, name: course.name, credits: course.credits, term: course.term, archived: !!course.archived,
    percent: percent == null ? null : round(percent), letter, points: letter ? GPA_POINTS[letter] : null,
    target, targetMin, needed,
    min: min == null ? null : round(min), max: max == null ? null : round(max),
    weighted, totalWeight: round(totalW), gradedWeight: round(gradedW, 2), earnedWeight: round(earnedW, 2),
    // A part with scores but no count is treated as finished, which overstates what's done.
    uncounted: weighted ? course.categories.filter((k) => !k.count && categories.some((c) => c.id === k.id && c.count)).length : 0,
    categories, count: graded.length, uncategorized, trend,
    scale, customScale: !!(course.scale && course.scale.length),
  };
}

function overview(data) {
  const courses = data.courses.map((c) => summarize(c, data.settings));
  const active = courses.filter((c) => !c.archived);
  const counted = active.filter((c) => c.points != null && c.credits > 0);
  const credits = counted.reduce((s, c) => s + c.credits, 0);
  const gpa = credits ? round(counted.reduce((s, c) => s + c.points * c.credits, 0) / credits, 2) : null;
  const pcts = active.filter((c) => c.percent != null);
  return {
    gpa, credits: round(credits, 2),
    average: pcts.length ? round(pcts.reduce((s, c) => s + c.percent, 0) / pcts.length) : null,
    courses,
    atRisk: active.filter((c) => c.needed && (c.needed.status === 'out-of-reach' || c.needed.status === 'stretch' || c.needed.status === 'missed')).map((c) => c.id),
    graded: active.reduce((s, c) => s + c.count, 0),
    settings: data.settings,
  };
}

function getGrades() {
  const data = load();
  return { courses: data.courses, summary: overview(data), defaultScale: DEFAULT_SCALE };
}

/** What the assistant sees, when grades are shared with it. */
function forAi(data) {
  if (data.settings.shareWithAi === false) return { private: true, note: 'The student keeps their grades private from the assistant.' };
  const o = overview(data);
  return {
    gpa: o.gpa, credits: o.credits, term: data.settings.term || undefined,
    courses: data.courses.filter((c) => !c.archived).map((c) => {
      const s = summarize(c, data.settings);
      const cats = Object.fromEntries(c.categories.map((k) => [k.id, k.name]));
      return {
        course: c.code || c.name, name: c.name || undefined, credits: c.credits,
        current: s.percent == null ? 'no grades yet' : `${s.percent}% (${s.letter})`,
        target: s.target || undefined,
        needOnRemainingWork: s.needed && s.needed.percent != null ? `${s.needed.percent}% on the remaining ${s.needed.leftWeight}% of the grade for ${s.needed.letter} (${s.needed.status})` : undefined,
        canStillFinishBetween: s.min != null ? `${s.min}% and ${s.max}%` : undefined,
        categories: s.categories.map((k) => ({ name: k.name, weight: `${k.weight}%`, average: k.percent == null ? null : `${k.percent}%`, graded: k.count, outOf: k.expected || undefined, dropsLowest: k.drop || undefined })),
        recent: [...c.grades].sort((a, b) => String(b.date || b.at).localeCompare(String(a.date || a.at))).slice(0, 8)
          .map((g) => ({ title: g.title, score: `${g.score}/${g.outOf}`, category: cats[g.category] || null, date: g.date || undefined, excused: g.excused || undefined })),
      };
    }),
  };
}

module.exports = {
  load, save, change, getGrades, overview, summarize, forAi,
  upsertCourse, removeCourse, upsertGrade, removeGrade, validateGrade, setSettings, applyGrading,
  findCourse, guessCategory, letterFor, codeKey, courseKeys, sameCourse, cleanScale,
  DEFAULT_SCALE, GPA_POINTS, DATA_FILE,
};
