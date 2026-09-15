'use strict';
/**
 * autotasks.js - everything the Google sync captured, and what you decided
 * about it.
 *
 * Kept apart from tasks.json on purpose. tasks.json is the file you write by
 * hand; this one is written by the engine every ten minutes. Mixing them means
 * either the sync overwrites your edits or your edits confuse the sync.
 *
 * A dismissal is permanent for that assignment. If a later email mentions the
 * same assignment again it stays dismissed - otherwise "Not homework" would be
 * a button that works until the next reminder email.
 */

const fs = require('fs');
const path = require('path');

const dedupe = require('./dedupe');

// RATCHET_DATA_DIR lets a test server use a scratch copy instead of yours.
const ROOT = process.env.RATCHET_DATA_DIR || path.join(__dirname, '..');
const FILE = path.join(ROOT, 'auto-tasks.json');
const HISTORY_FILE = path.join(ROOT, 'history.json');

const DEFAULT_LADDERS = {
  // A deadline is useful the day before, so homework starts nagging early.
  // It only shields once confirmed, and only after it is actually late.
  homework: [
    { afterMinutes: -1440, level: 'nudge' },
    { afterMinutes: -180, level: 'persistent' },
    { afterMinutes: 60, level: 'shield_social', groups: ['distractions'] },
    { afterMinutes: 720, level: 'shield_all' },
  ],
  // An exam cannot be done late, so there is nothing to enforce afterwards.
  // Two days of warning, and that is all.
  exam: [
    { afterMinutes: -2880, level: 'nudge' },
    { afterMinutes: -1440, level: 'persistent' },
  ],
  // Measured from when the oldest unanswered email arrived plus the grace
  // period, so "0" here means "you have now had a day".
  replies: [
    { afterMinutes: 0, level: 'nudge' },
    { afterMinutes: 1440, level: 'persistent' },
    { afterMinutes: 2880, level: 'shield_social', groups: ['distractions'] },
  ],
};

function empty() {
  return { version: 1, homework: {}, replies: {}, events: {}, sync: {} };
}

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, ''));
    return { ...empty(), ...s };
  } catch (_) {
    return empty();
  }
}

/** Task ids with a completion or pass, so merging duplicates never undoes a Done. */
function doneKeys() {
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8').replace(/^﻿/, ''));
    return new Set((h.records || []).map((r) => r.taskId));
  } catch (_) {
    return new Set();
  }
}

/**
 * Every save folds duplicates together first, whatever added them: the sync,
 * a syllabus in Files, or the assistant. See dedupe.js.
 */
function save(state, { skipDedupe = false } = {}) {
  if (!skipDedupe && state && state.homework) dedupe.dedupeHomework(state, doneKeys());
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}

/* -------------------------------- homework ------------------------------- */

/**
 * Fold freshly extracted candidates into the saved state.
 *
 * Which deadline wins when sources disagree: a calendar entry beats an email,
 * because a course-site calendar is the system of record and an email is
 * somebody's summary of it. Between two emails, the newer one wins, because a
 * "due date changed" notice is by definition the later message.
 */
function mergeHomework(state, candidates, now = new Date(), options = {}) {
  const importPastDays = options.importPastDays ?? 2;
  let added = 0;
  let updated = 0;

  for (const c of candidates) {
    if (!c || !c.key) continue;
    // A copy folded into another entry passes its news (a moved date, a new
    // source) on to the one that was kept.
    let existing = state.homework[c.key];
    let redirected = false;
    if (existing && existing.mergedInto && state.homework[existing.mergedInto] && !state.homework[existing.mergedInto].dismissed) {
      existing = state.homework[existing.mergedInto];
      redirected = true;
    }
    const dueIso = c.dueAt.toISOString();

    if (!existing) {
      // Connecting an account should not import a month of old deadlines
      // and open with a wall of overdue work.
      if (c.dueAt.getTime() < now.getTime() - importPastDays * 86400000) continue;

      state.homework[c.key] = {
        key: c.key,
        kind: c.kind,
        title: c.title,
        course: c.course || '',
        dueAt: dueIso,
        hasTime: !!c.hasTime,
        dueFrom: c.source,
        sources: [c.source],
        firstSeen: now.toISOString(),
        lastSeen: now.toISOString(),
        confirmed: false,
        dismissed: false,
      };
      added++;
      continue;
    }

    existing.lastSeen = now.toISOString();
    if (!existing.sources.some((s) => s.type === c.source.type && s.ref === c.source.ref)) {
      existing.sources.push(c.source);
      if (existing.sources.length > 10) existing.sources = existing.sources.slice(-10);
    }

    const current = existing.dueFrom || {};
    const calendarWins = c.source.type === 'calendar' && current.type !== 'calendar';
    const newerEmail = c.source.type === 'email' && current.type === 'email' &&
      new Date(c.source.at) > new Date(current.at);
    // A merged copy's calendar entry is the same assignment's calendar entry.
    const sameSourceMoved = (c.source.type === current.type && c.source.ref === current.ref) ||
      (redirected && c.source.type === 'calendar');

    if ((calendarWins || newerEmail || sameSourceMoved) && existing.dueAt !== dueIso) {
      existing.dueAt = dueIso;
      existing.hasTime = !!c.hasTime;
      existing.dueFrom = c.source;
      updated++;
    } else if (calendarWins) {
      existing.dueFrom = c.source;
    }
  }

  return { added, updated };
}

function setHomework(state, key, patch) {
  const item = state.homework[key];
  if (!item) return null;
  Object.assign(item, patch);
  return item;
}

/* ------------------------------ events from email ------------------------ */

/**
 * Fold event suggestions found in email into the saved state.
 *
 * Nothing here goes on the calendar by itself: a suggestion waits for Add or
 * Dismiss. If a newer email moves an event you have not decided on yet, the
 * suggestion moves with it. Once you have added one, a later email that
 * changes the time updates it too, and says so; a dismissed one stays gone.
 */
function mergeEvents(state, candidates, now = new Date()) {
  state.events = state.events || {};
  let added = 0;
  let updated = 0;
  for (const c of candidates) {
    if (!c || !c.key) continue;
    const existing = state.events[c.key];
    if (!existing) {
      state.events[c.key] = {
        key: c.key,
        title: c.title,
        start: c.start.toISOString(),
        end: c.end.toISOString(),
        location: c.location || '',
        source: c.source,
        firstSeen: now.toISOString(),
        confirmed: false,
        dismissed: false,
      };
      added++;
      continue;
    }
    if (existing.dismissed) continue;
    const newer = new Date(c.source.at) > new Date((existing.source || {}).at || 0);
    if (newer && (existing.start !== c.start.toISOString() || existing.end !== c.end.toISOString())) {
      existing.start = c.start.toISOString();
      existing.end = c.end.toISOString();
      existing.location = c.location || existing.location;
      existing.source = c.source;
      if (existing.confirmed) existing.movedAt = now.toISOString();
      updated++;
    }
  }
  // Suggestions for things that are over, and you never decided on, are forgotten.
  for (const [k, v] of Object.entries(state.events)) {
    if (!v.confirmed && now - new Date(v.end) > 86400000) delete state.events[k];
    else if (v.confirmed && now - new Date(v.end) > 60 * 86400000) delete state.events[k];
  }
  return { added, updated };
}

function setEvent(state, key, patch) {
  const item = (state.events || {})[key];
  if (!item) return null;
  Object.assign(item, patch);
  return item;
}

/* --------------------------------- replies ------------------------------- */

/**
 * Replace one account's set of threads that are waiting on you.
 *
 * A dismissal sticks only while the thread is unchanged. If they write again,
 * `since` moves, and it is waiting on you again - which is correct, because
 * "no reply needed" was a judgement about the old message, not the new one.
 */
function setReplies(state, account, waiting, now = new Date()) {
  const keep = {};
  for (const [k, v] of Object.entries(state.replies)) {
    if (v.account !== account) keep[k] = v;
  }

  for (const w of waiting) {
    const k = `${account}:${w.threadId}`;
    const prev = state.replies[k];
    const sinceIso = new Date(w.since).toISOString();
    keep[k] = {
      key: k,
      account,
      threadId: w.threadId,
      subject: w.subject || '(no subject)',
      from: w.from || '',
      since: sinceIso,
      dismissedAt: prev && prev.since === sinceIso ? prev.dismissedAt || null : null,
      lastSeen: now.toISOString(),
    };
  }

  state.replies = keep;
}

function dismissReplies(state, keys, now = new Date()) {
  let n = 0;
  for (const v of Object.values(state.replies)) {
    if (v.dismissedAt) continue;
    if (keys === 'all' || (Array.isArray(keys) && keys.includes(v.key))) {
      v.dismissedAt = now.toISOString();
      n++;
    }
  }
  return n;
}

/** Undo a dismissal from the last few minutes, matching the Undo on tasks. */
function undismissReplies(state, withinMinutes = 5, now = new Date()) {
  let n = 0;
  for (const v of Object.values(state.replies)) {
    if (v.dismissedAt && now - new Date(v.dismissedAt) <= withinMinutes * 60000) {
      v.dismissedAt = null;
      n++;
    }
  }
  return n;
}

/* ----------------------------- into schedule tasks ----------------------- */

/**
 * Turn saved state into tasks the scheduler understands.
 *
 * Exams disappear two hours after they start, since there is nothing left to
 * do. Unconfirmed homework disappears three days after its deadline, so a
 * misread email does not nag forever. Confirmed homework stays until you mark
 * it done, because you told the system it was real.
 */
function toTasks(state, options = {}) {
  const now = options.now || new Date();
  const ladders = { ...DEFAULT_LADDERS, ...(options.ladders || {}) };
  const replyWithinHours = options.replyWithinHours ?? 24;
  const tasks = [];

  for (const item of Object.values(state.homework)) {
    if (item.dismissed) continue;
    const due = new Date(item.dueAt);
    if (Number.isNaN(due.getTime())) continue;
    const ageH = (now - due) / 3600000;
    if (item.kind === 'exam' && ageH > 2) continue;
    if (!item.confirmed && ageH > 72) continue;

    tasks.push({
      id: item.key,
      title: item.title,
      course: item.course,
      // Things read from a dropped file can be plain to-dos rather than schoolwork.
      group: item.group || 'school',
      kind: item.kind,
      auto: true,
      confirmed: !!item.confirmed,
      clearedBy: item.kind === 'exam' ? 'Study for it, then mark it done'
        : item.group === 'todo' ? 'Do it, then mark it done' : 'Submit it, then mark it done',
      cadence: { type: 'once', dueAt: item.dueAt },
      escalation: ladders[item.kind] || ladders.homework,
      source: item.dueFrom,
      sources: item.sources,
    });
  }

  const waiting = Object.values(state.replies)
    .filter((r) => !r.dismissedAt)
    .sort((a, b) => new Date(a.since) - new Date(b.since));

  if (waiting.length) {
    const oldest = new Date(waiting[0].since);
    tasks.push({
      // Tied to the oldest waiting thread so that spending a pass or clearing
      // it applies to this batch, not to every email you ever receive.
      id: `email-replies@${oldest.getTime()}`,
      title: waiting.length === 1 ? 'Reply to 1 email' : `Reply to ${waiting.length} emails`,
      group: 'email',
      kind: 'replies',
      auto: true,
      doneAction: 'dismiss-replies',
      confirmed: options.repliesConfirmed === true,
      clearedBy: 'Reply, or mark the ones that do not need it',
      cadence: { type: 'once', dueAt: new Date(oldest.getTime() + replyWithinHours * 3600000).toISOString() },
      escalation: ladders.replies,
      threads: waiting.map((r) => ({
        key: r.key, account: r.account, subject: r.subject, from: r.from, since: r.since,
        link: `https://mail.google.com/mail/u/${encodeURIComponent(r.account)}/#inbox/${r.threadId}`,
      })),
    });
  }

  return tasks;
}

/** Forget everything captured from one account, used when disconnecting it. */
function forgetAccount(state, account) {
  for (const [k, v] of Object.entries(state.homework)) {
    v.sources = (v.sources || []).filter((s) => s.account !== account);
    if (!v.sources.length && !v.confirmed) delete state.homework[k];
  }
  for (const [k, v] of Object.entries(state.replies)) {
    if (v.account === account) delete state.replies[k];
  }
  for (const [k, v] of Object.entries(state.events || {})) {
    if ((v.source || {}).account === account && !v.confirmed) delete state.events[k];
  }
  delete state.sync[account];
}

module.exports = {
  FILE, DEFAULT_LADDERS,
  load, save, empty, doneKeys,
  mergeHomework, setHomework,
  mergeEvents, setEvent,
  setReplies, dismissReplies, undismissReplies,
  toTasks, forgetAccount,
};
