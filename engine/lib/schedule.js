'use strict';
/**
 * schedule.js - the part that decides. Pure functions only.
 *
 * Everything here takes a clock rather than reading one, so the whole
 * escalation ladder can be tested at 3am on a Tuesday three weeks from now
 * without waiting for it. The client holds no opinion about cadences; this is
 * where those opinions live, and it is the only place they live.
 */

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const LEVELS = ['clear', 'nudge', 'persistent', 'shield_social', 'shield_all'];

function levelRank(level) {
  const i = LEVELS.indexOf(level);
  return i === -1 ? 0 : i;
}

/* ------------------------------- date helpers ---------------------------- */

/** Local calendar day as YYYY-MM-DD. Local, not UTC - deadlines are human. */
function dayKey(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

function addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/** "21:00" applied to a given day, in local time. */
function deadlineOn(day, dueBy) {
  const [h, m] = String(dueBy || '23:59').split(':').map(Number);
  const out = startOfDay(day);
  out.setHours(Number.isFinite(h) ? h : 23, Number.isFinite(m) ? m : 59, 0, 0);
  return out;
}

/** "2d 4h", "3h 10m", "12m". Never "0m" - that reads as a bug. */
function formatDuration(minutes) {
  const mins = Math.max(0, Math.round(minutes));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${Math.max(1, m)}m`;
}

/* -------------------------------- cadence -------------------------------- */

/**
 * Is this task due on this calendar day at all?
 * everyNDays is handled separately - it keys off the last completion, not the
 * calendar, so there is no fixed set of days to ask about.
 */
function isScheduledDay(task, day) {
  const c = task.cadence || {};
  switch (c.type) {
    case 'daily':
      return true;
    case 'weekdays':
      return day.getDay() >= 1 && day.getDay() <= 5;
    case 'days':
      return (c.days || []).map((s) => String(s).toLowerCase()).includes(DAY_NAMES[day.getDay()]);
    default:
      return false;
  }
}

/**
 * Every record that satisfies a task, keyed by the local day it landed on.
 * A pass counts exactly as a completion does - that is what a pass is for.
 */
function satisfiedDays(history, taskId) {
  const out = new Set();
  for (const rec of history.records || []) {
    if (rec.taskId !== taskId) continue;
    out.add(dayKey(new Date(rec.at)));
  }
  return out;
}

/**
 * Which occurrences of a recurring task have been satisfied, keyed by the day
 * each occurrence falls on.
 *
 * Matching a completion to the calendar day it happened on is wrong in both
 * directions: laundry due Sunday and done on Monday would stay overdue - and
 * keep your games blocked - after you had done it, and laundry done early on
 * Saturday would not count for Sunday at all.
 *
 * So each completion, oldest first, is matched like this:
 *   1. If an earlier occurrence is still unpaid, it pays off the oldest one.
 *      Late is late, but done is done.
 *   2. Otherwise it counts towards the next deadline - as long as it came
 *      after the previous deadline. Doing laundry twice on Saturday does not
 *      pre-clear next week.
 * Completions from before the task started count for nothing.
 */
function satisfiedOccurrences(task, history, now, lookbackDays = 21, lookaheadDays = 14) {
  const c = task.cadence || {};
  const floor = earliestDay(task, history, now);
  const records = (history.records || [])
    .filter((r) => r.taskId === task.id)
    .map((r) => new Date(r.at))
    .filter((d) => !Number.isNaN(d.getTime()) && d >= floor)
    .sort((a, b) => a - b);

  const out = new Set();
  if (!records.length) return out;

  let start = addDays(startOfDay(now), -lookbackDays);
  if (start < floor) start = floor;
  const end = addDays(startOfDay(now), lookaheadDays);

  const occ = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    if (isScheduledDay(task, d)) occ.push({ key: dayKey(d), deadline: deadlineOn(d, c.dueBy), paid: false });
  }

  for (const r of records) {
    const overdue = occ.find((o) => !o.paid && o.deadline < r);
    if (overdue) { overdue.paid = true; out.add(overdue.key); continue; }

    const i = occ.findIndex((o) => !o.paid && o.deadline >= r);
    if (i === -1) continue;
    const previous = occ[i - 1];
    if (previous && previous.deadline >= r) continue;
    occ[i].paid = true;
    out.add(occ[i].key);
  }
  return out;
}

/**
 * The occurrence a recurring task is "on" today: today, if it is scheduled
 * today, otherwise the most recent one. It is what "done" means on the
 * dashboard - laundry done on Monday reads as done all week.
 */
function currentOccurrenceKey(task, now) {
  for (let back = 0; back <= 31; back++) {
    const d = addDays(startOfDay(now), -back);
    if (isScheduledDay(task, d)) return dayKey(d);
  }
  return null;
}

function lastSatisfiedAt(history, taskId) {
  let latest = null;
  for (const rec of history.records || []) {
    if (rec.taskId !== taskId) continue;
    const t = new Date(rec.at).getTime();
    if (latest === null || t > latest) latest = t;
  }
  return latest;
}

/**
 * The first day this task counts from.
 *
 * Without this, adding a task on a Friday makes it instantly two weeks late,
 * because every day in the lookback window is a day you did not do a thing
 * that did not exist. `startedOn` says it explicitly; otherwise we start at
 * the first time you ever cleared it, and failing that, today.
 */
function earliestDay(task, history, now) {
  if (task.startedOn) {
    const [y, m, d] = String(task.startedOn).split('-').map(Number);
    if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
      return new Date(y, m - 1, d, 0, 0, 0, 0);
    }
  }

  let first = null;
  for (const rec of history.records || []) {
    if (rec.taskId !== task.id) continue;
    const t = new Date(rec.at).getTime();
    if (first === null || t < first) first = t;
  }
  return first !== null ? startOfDay(new Date(first)) : startOfDay(now);
}

/**
 * For a one-off task - an assignment, an exam - how far from its deadline are
 * we? Negative before it is due, positive after. Null once it has been done.
 *
 * Recurring tasks only ever care about lateness. A deadline you get one shot at
 * is different: the useful warning is the one the day before, so a one-off
 * ladder may have rungs with negative afterMinutes.
 */
function relativeToDue(task, history, now) {
  const c = task.cadence || {};
  if (c.type !== 'once') return null;

  const dueAt = new Date(c.dueAt);
  if (Number.isNaN(dueAt.getTime())) return null;
  if (lastSatisfiedAt(history, task.id) !== null) return null;

  return { dueAt, minutes: (now - dueAt) / 60000 };
}

/**
 * The oldest missed instance of this task, or null if it is up to date.
 *
 * Oldest rather than newest on purpose: if you have missed three days, the
 * system should say three days, not one. Understating the debt is how you stop
 * believing the number.
 */
function findOverdue(task, history, now, lookbackDays = 14) {
  const c = task.cadence || {};

  if (c.type === 'once') {
    const rel = relativeToDue(task, history, now);
    if (!rel || rel.minutes < 0) return null;
    return { dueAt: rel.dueAt, overdueMinutes: rel.minutes };
  }

  const floor = earliestDay(task, history, now);

  if (c.type === 'everyNDays') {
    const n = Number(c.n) || 1;
    const last = lastSatisfiedAt(history, task.id);
    // Never cleared: it first comes due on its own start day, not N days
    // before you had ever heard of it.
    const base = last !== null ? addDays(startOfDay(new Date(last)), n) : floor;
    const due = deadlineOn(base, c.dueBy);
    if (now <= due) return null;
    return { dueAt: due, overdueMinutes: (now - due) / 60000 };
  }

  const done = satisfiedOccurrences(task, history, now, lookbackDays);
  let found = null;
  for (let back = lookbackDays; back >= 0; back--) {
    const day = addDays(startOfDay(now), -back);
    if (day < floor) continue;
    if (!isScheduledDay(task, day)) continue;
    if (done.has(dayKey(day))) continue;
    const due = deadlineOn(day, c.dueBy);
    if (now <= due) continue;
    found = { dueAt: due, overdueMinutes: (now - due) / 60000 };
    break; // Oldest first, so the first hit is the worst one.
  }
  return found;
}

/**
 * When this task next comes due, ignoring anything already missed.
 *
 * Needed so the dashboard can say "due 21:00" instead of "done" for a task
 * you have simply not reached yet. Those two are not the same sentence and
 * showing the wrong one makes the whole board untrustworthy.
 */
function nextDue(task, history, now, lookaheadDays = 14) {
  const c = task.cadence || {};

  if (c.type === 'once') {
    const rel = relativeToDue(task, history, now);
    return rel && rel.minutes < 0 ? rel.dueAt : null;
  }

  if (c.type === 'everyNDays') {
    const n = Number(c.n) || 1;
    const last = lastSatisfiedAt(history, task.id);
    const base = last !== null
      ? addDays(startOfDay(new Date(last)), n)
      : earliestDay(task, history, now);
    return deadlineOn(base, c.dueBy);
  }

  const done = satisfiedOccurrences(task, history, now);
  for (let i = 0; i <= lookaheadDays; i++) {
    const day = addDays(startOfDay(now), i);
    if (!isScheduledDay(task, day)) continue;
    if (done.has(dayKey(day))) continue;
    const due = deadlineOn(day, c.dueBy);
    if (due > now) return due;
  }
  return null;
}

/* ------------------------------- escalation ------------------------------ */

const DEFAULT_LADDER = [
  { afterMinutes: 0, level: 'nudge' },
  { afterMinutes: 60, level: 'persistent' },
  { afterMinutes: 120, level: 'shield_social', groups: ['distractions'] },
  { afterMinutes: 360, level: 'shield_all' },
];

/**
 * Which rung of the ladder does this much lateness put you on?
 */
function tierFor(task, overdueMinutes) {
  const ladder = (task.escalation && task.escalation.length ? task.escalation : DEFAULT_LADDER)
    .slice()
    .sort((a, b) => a.afterMinutes - b.afterMinutes);

  let tier = null;
  for (const rung of ladder) {
    if (overdueMinutes >= rung.afterMinutes) tier = rung;
  }
  return tier;
}

/**
 * Resolve one task to its current level and groups.
 *
 * The confirmation cap is the rule from the plan: a task nobody has confirmed
 * - one that arrived by itself from an email scan - can nag but cannot take
 * your machine away. A misparsed email that locks you out is how you learn to
 * distrust the whole system inside a week.
 */
function evaluateTask(task, history, now) {
  if (task.paused) return { task, level: 'clear', groups: [], overdue: null, dueIn: null };

  // One-off tasks are measured against their deadline in both directions, so
  // a rung at -1440 fires the day before. Recurring tasks only count lateness.
  let minutes;
  let overdue = null;
  let dueIn = null;
  if ((task.cadence || {}).type === 'once') {
    const rel = relativeToDue(task, history, now);
    if (!rel) return { task, level: 'clear', groups: [], overdue: null, dueIn: null };
    minutes = rel.minutes;
    if (minutes >= 0) overdue = { dueAt: rel.dueAt, overdueMinutes: minutes };
    else dueIn = { dueAt: rel.dueAt, minutes: -minutes };
  } else {
    overdue = findOverdue(task, history, now);
    if (overdue) {
      minutes = overdue.overdueMinutes;
    } else {
      // Not late. A recurring task can still warn ahead of its deadline, but
      // only if its ladder asks to - so nothing changes for tasks that don't.
      const warnsEarly = (task.escalation || []).some((r) => r.afterMinutes < 0);
      const upcoming = warnsEarly ? nextDue(task, history, now) : null;
      if (!upcoming) return { task, level: 'clear', groups: [], overdue: null, dueIn: null };
      minutes = (now - upcoming) / 60000;
      dueIn = { dueAt: upcoming, minutes: -minutes };
    }
  }

  const tier = tierFor(task, minutes);
  if (!tier) return { task, level: 'clear', groups: [], overdue, dueIn };

  let level = tier.level;
  let capped = false;
  if (task.confirmed === false && levelRank(level) > levelRank('persistent')) {
    level = 'persistent';
    capped = true;
  }

  return {
    task,
    level,
    capped,
    groups: level === 'shield_social' ? (tier.groups || ['distractions']) : [],
    overdue,
    dueIn,
  };
}

/* --------------------------------- passes -------------------------------- */

function passesUsed(history, now, windowDays = 7) {
  const cutoff = now.getTime() - windowDays * 86400000;
  return (history.records || []).filter(
    (r) => r.kind === 'pass' && new Date(r.at).getTime() >= cutoff
  ).length;
}

/* -------------------------------- the answer ----------------------------- */

/**
 * Build the payload the client polls for.
 *
 * The union rule lives in the two lines that merge groups: finishing your
 * reading does not unlock Steam while the email is still three days late,
 * because both tasks contribute to the same set and the highest level wins.
 */
function buildEnforcement(tasks, history, now, options = {}) {
  const evaluated = (tasks || []).map((t) => evaluateTask(t, history, now));

  let level = 'clear';
  const groups = new Set();

  for (const e of evaluated) {
    if (levelRank(e.level) > levelRank(level)) level = e.level;
    for (const g of e.groups) groups.add(g);
  }

  // A task at shield_all pulls everything in; the client resolves what that
  // means locally, so we only need to name the level.
  // Worst first: the latest overdue item leads, and anything not yet due
  // sorts after every late one, soonest deadline first.
  const urgency = (e) => (e.overdue ? e.overdue.overdueMinutes : -(e.dueIn ? e.dueIn.minutes : 0));
  const reasons = evaluated
    .filter((e) => e.level !== 'clear')
    .sort((a, b) => urgency(b) - urgency(a))
    .map((e) => ({
      taskId: e.task.id,
      title: e.task.title,
      overdueFor: e.overdue ? formatDuration(e.overdue.overdueMinutes) : null,
      dueIn: e.dueIn ? formatDuration(e.dueIn.minutes) : null,
      clearedBy: e.task.clearedBy || 'Mark it done on the dashboard',
      level: e.level,
      capped: !!e.capped,
    }));

  return {
    level,
    blocking: levelRank(level) >= levelRank('shield_social'),
    shieldGroups: [...groups],
    reasons,
    recheckInSeconds: options.recheckInSeconds || 60,
    generatedAt: now.toISOString(),
  };
}

module.exports = {
  LEVELS, levelRank, DEFAULT_LADDER,
  dayKey, startOfDay, addDays, deadlineOn, formatDuration,
  isScheduledDay, satisfiedDays, satisfiedOccurrences, currentOccurrenceKey,
  lastSatisfiedAt, earliestDay, findOverdue, nextDue, relativeToDue,
  tierFor, evaluateTask, passesUsed, buildEnforcement,
};
