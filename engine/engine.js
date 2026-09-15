'use strict';
/**
 * engine.js - the half that decides.
 *
 * Serves the contract the client already speaks, plus the dashboard:
 *
 *   GET  /api/enforcement      what level you are at and why   (the client polls this)
 *   GET  /api/state            every task, for the dashboard
 *   GET  /api/calendar         events and deadlines, merged, by day
 *   GET  /api/news             today's top stories, in the source's own ranking
 *   GET  /api/stocks           prices for the stocks in stocks.json
 *   GET  /api/finance          accounts, bills, budgets, goals, holdings, and the totals
 *   GET  /api/finance/brief    this morning's markets, business and money headlines
 *   POST /api/finance/save     add or change one item   { kind, item }
 *   POST /api/finance/delete   remove one               { kind, id }
 *   POST /api/finance/paid     mark a bill paid, or a payday received   { id, occurrence? }
 *   POST /api/finance/unpaid   take that back           { id, occurrence }
 *   POST /api/finance/ai       which parts of your finances Claude may read
 *
 *   GET  /api/ai/status        key present, model, this month's spend
 *   POST /api/ai/key           save or remove the Anthropic API key (PC only)
 *   POST /api/ai/settings      on/off, monthly limit, model
 *   POST /api/drops            a dropped file, as base64; read, filed in a folder, scanned in the background
 *   GET  /api/drops            the Files library: folders, files, and what could be added from each
 *   GET  /api/drops/file?id=   the original file, to open
 *   POST /api/drops/apply      add the items you ticked
 *   POST /api/drops/move       put a file in another folder
 *   POST /api/drops/folder     make a folder; /api/drops/folder/delete removes one you made
 *   GET  /api/setup            what the in-app guide needs: addresses, folder, platform
 *   POST /api/profile          the name the greeting uses
 *   POST /api/assistant/send   a message to the assistant
 *   GET  /api/assistant?id=    a conversation, for polling
 *   POST /api/assistant/decide approve or decline the change it proposed
 *   POST /api/assistant/undo   put back a file the assistant changed
 *   POST /api/news/subscription  which papers you subscribe to
 *   POST /api/events/add       put an event found in email on the calendar
 *   POST /api/events/dismiss   not an event, or not one you're going to
 *   POST /api/groups/decide    "yes, I'm in SAAC" or "not mine"   { id, join, attend? }
 *   POST /api/groups/add       a group you name yourself          { name, kind }
 *   POST /api/labels/set       Required or Optional for every entry with this title   { title, attend } or { title, reset }
 *   GET  /api/art              your own pictures in engine/art/, for the sleep screen
 *   GET  /art/<file>           one of those pictures
 *   POST /api/complete         mark a task done
 *   POST /api/pass             spend a pass on a task
 *   POST /api/undo             take back a misclick, within five minutes
 *
 *   GET  /api/google/status    connected accounts and how their last sync went
 *   POST /api/google/connect   start signing in a Google account
 *   GET  /oauth/callback       where Google sends the browser back to
 *   POST /api/google/sync      sync now rather than waiting for the timer
 *   POST /api/google/account   change what an account is used for
 *   POST /api/google/disconnect
 *
 *   POST /api/auto/confirm     "yes, this homework is real" - lets it shield
 *   POST /api/auto/dismiss     "not homework"
 *   POST /api/emails/dismiss   "does not need a reply"
 *   POST /api/emails/undo
 *
 * Zero dependencies, Node built-ins only, same as the client.
 *
 *   node engine.js
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const store = require('./lib/store');
const sched = require('./lib/schedule');
const calendar = require('./lib/calendar');
const autotasks = require('./lib/autotasks');
const sync = require('./lib/sync');
const oauth = require('./lib/google/oauth');
const { profileForToken } = require('./lib/google/api');

const news = require('./lib/news');
const stocks = require('./lib/stocks');
const finance = require('./lib/finance');
const health = require('./lib/health');
const versions = require('./lib/versions');
const updates = require('./lib/updates');
const drops = require('./lib/drops');
const dedupe = require('./lib/dedupe');
const claude = require('./lib/ai/claude');
const assistant = require('./lib/ai/assistant');
const organizer = require('./lib/ai/organize');
const labels = require('./lib/labels');
const groups = require('./lib/groups');

const DASHBOARD = path.join(__dirname, 'dashboard.html');

/* Your own pictures for the sleep screen. Drop them in engine/art/. */
const ART_DIR = path.join(__dirname, 'art');
const ART_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

/* --------------------------------- logging ------------------------------- */

const LOG_FILE = path.join(__dirname, 'engine.log');

function log(msg) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const line = `[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

/* -------------------------------- responses ------------------------------ */

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    // The charset matters: course calendars are full of em dashes, and a
    // client that assumes Latin-1 turns every one into "â€”".
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, code, html) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * A JSON body, capped. Most writes are tiny; a dropped file arrives as base64
 * and gets a limit of its own. Over the cap, the body comes back as
 * { _tooLarge: true } rather than a silently empty object.
 */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) { done = true; resolve({ _tooLarge: true }); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (_) { resolve({}); }
    });
    req.on('error', () => { if (!done) { done = true; resolve({}); } });
  });
}

/* --------------------------------- tasks --------------------------------- */

/**
 * Every task in play: the ones you wrote in tasks.json, and the ones the
 * Google sync found. The scheduler cannot tell them apart and does not need to.
 */
function allTasks(now = new Date()) {
  const manual = store.loadTasks();
  const settings = sync.loadSettings();
  const auto = autotasks.toTasks(autotasks.load(), {
    now,
    ladders: settings.ladders,
    replyWithinHours: settings.replyWithinHours,
    repliesConfirmed: settings.repliesCanShield === true,
  });
  // What the Finance page is still missing. These only nudge, and clear
  // themselves once filled in.
  let money = [];
  try { money = finance.setupTasks(now); } catch (e) { log(`finance setup tasks skipped: ${e.message}`); }
  return manual.concat(auto, money);
}

function currentState(cfg, now = new Date()) {
  const history = store.loadHistory();
  const tasks = allTasks(now);
  const enforcement = sched.buildEnforcement(tasks, history, now, {
    recheckInSeconds: cfg.recheckInSeconds,
  });

  const used = sched.passesUsed(history, now);

  const detail = [];
  for (const t of tasks) {
    const once = (t.cadence || {}).type === 'once';
    const last = sched.lastSatisfiedAt(history, t.id);

    // A finished one-off task stays visible for a day so an accidental Done
    // can be seen and undone, then gets out of the way.
    if (once && last !== null && now - last > 86400000) continue;

    const e = sched.evaluateTask(t, history, now);
    const upcoming = sched.nextDue(t, history, now);
    detail.push({
      id: t.id,
      title: t.title,
      course: t.course || '',
      group: t.group || 'other',
      kind: t.kind || null,
      provider: providerOf(t.source),
      auto: !!t.auto,
      once,
      clearedBy: t.clearedBy || '',
      paused: !!t.paused,
      confirmed: t.confirmed !== false,
      level: e.level,
      capped: !!e.capped,
      overdueFor: e.overdue ? sched.formatDuration(e.overdue.overdueMinutes) : null,
      dueIn: e.dueIn ? sched.formatDuration(e.dueIn.minutes) : null,
      dueAt: once ? new Date(t.cadence.dueAt).toISOString() : (e.overdue ? e.overdue.dueAt.toISOString() : null),
      nextDueAt: upcoming ? upcoming.toISOString() : null,
      done: once ? last !== null
        : (!e.overdue && sched.satisfiedOccurrences(t, history, now).has(sched.currentOccurrenceKey(t, now))),
      lastDoneAt: last ? new Date(last).toISOString() : null,
      requiresNote: !!t.requiresNote,
      minNoteWords: t.minNoteWords || 0,
      doneAction: t.doneAction || null,
      source: t.source || null,
      threads: t.threads || null,
      go: t.go || null,
    });
  }

  return {
    enforcement,
    tasks: detail,
    passes: { used, perWeek: cfg.passesPerWeek, remaining: Math.max(0, cfg.passesPerWeek - used) },
    stats: weekStats(tasks, history, now),
    profile: { name: cfg.name || '' },
    now: now.toISOString(),
  };
}

/**
 * The numbers the dashboard celebrates: how much of this week is done, and how
 * many days running you have cleared something.
 *
 * The streak counts days with at least one thing marked done, ending today -
 * or yesterday, so it does not read zero every morning before you have started.
 * Passes do not count towards it. A pass is allowed; it is not an achievement.
 */
function weekStats(tasks, history, now) {
  const today = sched.startOfDay(now);
  const monday = sched.addDays(today, -((today.getDay() + 6) % 7));
  const sunday = new Date(sched.addDays(monday, 7).getTime() - 1);

  // The ring is "what you have done this week" against "that plus what is
  // still left to do by Sunday". Catching up on last week's laundry on Monday
  // fills it, rather than leaving it at zero until next Sunday - a progress
  // bar that ignores the thing you just did is a bad way to say well done.
  let remaining = 0;
  for (const t of tasks) {
    // Finance to-dos clear by being filled in, not by a Done, so they are not in the ring.
    if (t.paused || t.doneAction || t.group === 'finance') continue;
    const c = t.cadence || {};
    if (c.type === 'once') {
      const due = new Date(c.dueAt);
      if (due > sunday) continue;
      if (t.kind === 'exam' && due < now) continue;
      if (sched.lastSatisfiedAt(history, t.id) === null) remaining++;
      continue;
    }
    if (c.type === 'everyNDays') continue;
    const floor = sched.earliestDay(t, history, now);
    const satisfied = sched.satisfiedOccurrences(t, history, now);
    for (let d = sched.addDays(today, -14); d <= sunday; d = sched.addDays(d, 1)) {
      if (d < floor || !sched.isScheduledDay(t, d)) continue;
      if (!satisfied.has(sched.dayKey(d))) remaining++;
    }
  }

  const doneDays = new Set((history.records || [])
    .filter((r) => r.kind === 'done')
    .map((r) => sched.dayKey(new Date(r.at))));
  let streak = 0;
  let cursor = doneDays.has(sched.dayKey(today)) ? today : sched.addDays(today, -1);
  while (doneDays.has(sched.dayKey(cursor))) {
    streak++;
    cursor = sched.addDays(cursor, -1);
  }

  const doneThisWeek = (history.records || []).filter(
    (r) => r.kind === 'done' && new Date(r.at) >= monday && new Date(r.at) <= sunday
  ).length;

  return {
    weekTotal: doneThisWeek + remaining,
    weekDone: doneThisWeek,
    weekRemaining: remaining,
    doneThisWeek,
    streakDays: streak,
  };
}

/* ------------------------------- artwork --------------------------------- */

/**
 * Only plain image filenames directly inside engine/art/. No subfolders and no
 * dots-and-slashes, so the sleep screen can show your pictures without the
 * server becoming a way to read anything else in the engine folder.
 */
function artNameOk(name) {
  return /^[\w][\w\- .()',&]{0,120}$/.test(name) && !name.includes('..') && !!ART_TYPES[path.extname(name).toLowerCase()];
}

function ownArtwork() {
  try {
    return fs.readdirSync(ART_DIR).filter(artNameOk).sort().map((f) => ({
      file: f,
      url: `/art/${encodeURIComponent(f)}`,
      title: path.basename(f, path.extname(f)).replace(/[_-]+/g, ' ').trim(),
    }));
  } catch (_) {
    return [];
  }
}

function sendArtwork(res, name) {
  if (!artNameOk(name)) { res.writeHead(404); return res.end('not found'); }
  const file = path.join(ART_DIR, name);
  if (path.dirname(file) !== ART_DIR) { res.writeHead(404); return res.end('not found'); }
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': ART_TYPES[path.extname(name).toLowerCase()],
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=3600',
    });
    return res.end(buf);
  } catch (_) {
    res.writeHead(404); return res.end('not found');
  }
}

/* ------------------------------- calendar -------------------------------- */

function dayKeyOf(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Where an item came from, for the little logo beside it: Gmail, Google
 * Calendar, Canvas (by the sender or calendar), a dropped file, or the assistant.
 */
function providerOf(source) {
  const s = source || {};
  if (/instructure\.com|canvaslms|\bcanvas\b/i.test(`  `)) return 'canvas';
  if (s.type === 'email') return 'gmail';
  if (s.type === 'calendar') return 'google-calendar';
  if (s.type === 'file') return 'file';
  if (s.type === 'assistant') return 'assistant';
  if (s.type === 'finance') return 'finance';
  return null;
}

/**
 * Deadlines inside the window, so homework appears on the calendar on the day
 * it is due rather than only in a separate list.
 */
function deadlinesBetween(tasks, history, from, to, now) {
  const out = [];
  for (const t of tasks) {
    // An inbox is not an appointment. Unanswered email lives on the Tasks
    // page; on the calendar it would be a deadline that moves every time
    // someone writes to you.
    // Finance to-dos are not appointments either; they live on Tasks and Finance.
    if (t.paused || t.doneAction || t.group === 'finance') continue;
    const c = t.cadence || {};
    const e = sched.evaluateTask(t, history, now);
    const base = {
      type: 'deadline',
      taskId: t.id,
      title: t.title,
      course: t.course || '',
      group: t.group || 'other',
      kind: t.kind || null,
      provider: providerOf(t.source),
      auto: !!t.auto,
      confirmed: t.confirmed !== false,
      level: e.level,
    };

    if (c.type === 'once') {
      if (sched.lastSatisfiedAt(history, t.id) !== null) continue;
      const due = new Date(c.dueAt);
      if (due >= from && due <= to) out.push({ ...base, start: due.toISOString(), end: due.toISOString() });
      continue;
    }

    if (c.type === 'everyNDays') {
      const due = sched.nextDue(t, history, now);
      if (due && due >= from && due <= to) out.push({ ...base, start: due.toISOString(), end: due.toISOString() });
      continue;
    }

    const done = sched.satisfiedOccurrences(t, history, now);
    for (let d = new Date(from); d <= to; d = sched.addDays(d, 1)) {
      if (!sched.isScheduledDay(t, d)) continue;
      if (done.has(sched.dayKey(d))) continue;
      const due = sched.deadlineOn(d, c.dueBy);
      out.push({ ...base, start: due.toISOString(), end: due.toISOString() });
    }
  }
  return out;
}

/**
 * What is already in Mellow around the days a dropped file's suggestions fall
 * on: calendar events, deadlines and bills. Lets the Files page say "already
 * on your calendar" instead of offering to add a class twice.
 */
function existingForDrops(list) {
  const out = { schedule: [], bills: [], transactions: [], subscriptions: [] };
  try {
    const fin = finance.load();
    out.bills = (fin.bills || []).map((b) => b.name).filter(Boolean);
    out.subscriptions = (fin.subscriptions || []).filter((s) => s.status !== 'cancelled').map((s) => s.name).filter(Boolean);
    out.transactions = (fin.transactions || []).map((t) => drops.txnSignature(t.date, t.amount, t.description));
  } catch (_) {}
  const span = drops.itemSpan(list);
  if (!span) return out;
  const from = new Date(span.from.getTime() - 86400000);
  const to = new Date(Math.min(span.to.getTime() + 2 * 86400000, from.getTime() + 400 * 86400000));
  const push = (title, when, kind, allDay) => {
    const d = new Date(when);
    if (title && !Number.isNaN(d.getTime())) {
      out.schedule.push({ title, day: dayKeyOf(d), kind, minutes: allDay || kind === 'deadline' ? null : d.getHours() * 60 + d.getMinutes() });
    }
  };
  try { for (const e of sync.cachedEvents(from, to)) push(e.title, e.start, 'event', e.allDay); } catch (_) {}
  try { for (const e of calendar.eventsBetween(from, to)) push(e.title, e.start, 'event', e.allDay); } catch (_) {}
  const captured = autotasks.load();
  for (const e of Object.values(captured.events || {})) if (e.confirmed && !e.dismissed) push(e.title, e.start, 'event', e.allDay);
  for (const h of Object.values(captured.homework || {})) if (!h.dismissed) push(h.course ? `${h.course} ${h.title}` : h.title, h.dueAt, 'deadline');
  return out;
}

async function calendarPayload(cfg, days, fromDay = null) {
  const now = new Date();
  const base = fromDay || now;
  const from = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const to = new Date(from.getTime() + days * 86400000 - 1);

  const feeds = await calendar.refreshFeeds();
  const icsEvents = calendar.eventsBetween(from, to).map((e) => ({
    type: 'event',
    uid: e.uid,
    title: e.title,
    location: e.location,
    start: e.start.toISOString(),
    end: e.end.toISOString(),
    allDay: e.allDay,
    calendar: e.calendar,
    color: e.color,
    provider: 'ics',
  }));
  const googleEvents = sync.cachedEvents(from, to).map((e) => ({
    type: 'event',
    uid: e.uid,
    title: e.title,
    location: e.location,
    start: e.start.toISOString(),
    end: e.end.toISOString(),
    allDay: e.allDay,
    calendar: e.calendar,
    color: e.color,
    link: e.link,
    provider: 'google-calendar',
  }));

  // Events found in email: the ones you added sit on the calendar like any
  // other; the ones still waiting on a decision go out as suggestions.
  const captured = Object.values(autotasks.load().events || {});
  // A class meeting added from a syllabus that your Google or .ics calendar
  // already has is left off, not deleted: if the calendar entry goes, it comes back.
  const calendarProper = googleEvents.concat(icsEvents);
  const emailEvents = captured
    .filter((e) => e.confirmed && !e.dismissed && new Date(e.end) >= from && new Date(e.start) <= to)
    .filter((e) => {
      const kind = (e.source || {}).type;
      return (kind !== 'file' && kind !== 'assistant') || !dedupe.coveredBy(e, calendarProper);
    })
    .map((e) => {
      const kind = (e.source || {}).type;
      return {
        type: 'event',
        uid: `email:${e.key}`,
        title: e.title,
        location: e.location,
        start: new Date(e.start).toISOString(),
        end: new Date(e.end).toISOString(),
        allDay: !!e.allDay,
        // Events added from a dropped file or by the assistant share this
        // store with the ones found in email; the label says which.
        calendar: kind === 'file' ? 'From a file' : kind === 'assistant' ? 'Added by the assistant' : 'From email',
        fromEmail: e.key,
        addedFrom: kind === 'file' ? `From ${e.source.name}` : kind === 'assistant' ? 'Assistant' : 'From email',
        moved: !!e.movedAt,
        provider: kind === 'file' ? 'file' : kind === 'assistant' ? 'assistant' : providerOf(e.source),
        link: e.source && e.source.account ? `https://mail.google.com/mail/u/${encodeURIComponent(e.source.account)}/#all/${e.source.threadId}` : '',
      };
    });
  const suggestions = captured
    .filter((e) => !e.confirmed && !e.dismissed && new Date(e.end) >= now)
    .sort((a, b) => new Date(a.start) - new Date(b.start))
    .map((e) => ({
      key: e.key,
      title: e.title,
      start: e.start,
      end: e.end,
      location: e.location,
      from: (e.source || {}).from || '',
      subject: (e.source || {}).subject || '',
      matched: (e.source || {}).matched || '',
      provider: providerOf(e.source),
      link: e.source && e.source.account ? `https://mail.google.com/mail/u/${encodeURIComponent(e.source.account)}/#all/${e.source.threadId}` : '',
    }));

  const history = store.loadHistory();
  const tasks = allTasks(now);
  const deadlines = deadlinesBetween(tasks, history, from, to, now);

  // Homework found on a calendar is already on the calendar. Rather than show
  // the event and a deadline for the same thing, the event itself becomes the
  // deadline: it keeps its location and gains the Done button.
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const allEvents = [...googleEvents, ...icsEvents, ...emailEvents];
  const eventsByUid = new Map(allEvents.map((e) => [e.uid, e]));
  const keptDeadlines = deadlines.filter((d) => {
    const src = (tasksById.get(d.taskId) || {}).source;
    if (!src || src.type !== 'calendar') return true;
    const ev = eventsByUid.get(`${src.account}:${src.ref}`);
    if (!ev) return true;
    Object.assign(ev, {
      taskId: d.taskId, kind: d.kind, course: d.course, level: d.level, confirmed: d.confirmed, isDeadline: true,
    });
    return false;
  });

  // The same event can reach Mellow twice: a school calendar shared into the
  // personal account, or a Google calendar also added as an .ics feed. Same
  // title at the same start and end is the same event. When one copy has
  // become a deadline, that is the copy kept.
  const bySignature = new Map();
  for (const e of allEvents) {
    const k = `${String(e.title).trim().toLowerCase()}|${e.start}|${e.end}`;
    const prev = bySignature.get(k);
    if (!prev || (e.isDeadline && !prev.isDeadline)) bySignature.set(k, e);
  }
  const events = [...bySignature.values()];

  // Groups you might be in, noticed from what is on the calendar; and a label
  // on every entry: what it is, whether you have to be there, whose it is.
  let gstate = groups.load();
  try {
    const r = groups.observe(gstate, groups.signalsFromEvents(events), now);
    if (r.changed) groups.save(gstate);
  } catch (e) {
    log(`groups: calendar check skipped: ${e.message}`);
  }
  const labelCtx = {
    groups: groups.joined(gstate),
    overrides: gstate.overrides,
    courses: new Set([
      ...labels.coursesIn(events.map((e) => e.title)),
      ...tasks.map((t) => String(t.course || '').toLowerCase()).filter(Boolean),
    ]),
  };
  for (const e of events) {
    if (e.isDeadline && e.kind !== 'exam') continue;
    e.label = labels.classify(e, labelCtx);
  }
  for (const d of keptDeadlines) {
    if (d.kind === 'exam') d.label = labels.classify({ title: d.course ? `${d.course} — ${d.title}` : d.title }, labelCtx);
  }
  for (const s of suggestions) s.label = labels.classify(s, labelCtx);

  const byDay = new Map();
  for (let d = new Date(from); d <= to; d = sched.addDays(d, 1)) byDay.set(dayKeyOf(d), []);
  for (const item of [...keptDeadlines, ...events]) {
    const key = dayKeyOf(new Date(item.start));
    if (byDay.has(key)) byDay.get(key).push(item);
  }

  // Within a day: all-day entries first, then by time, and at the same
  // minute a deadline sorts ahead of an event.
  const sorted = [...byDay.entries()].map(([day, items]) => ({
    day,
    items: items.sort((a, b) => {
      if (!!a.allDay !== !!b.allDay) return a.allDay ? -1 : 1;
      const t = new Date(a.start) - new Date(b.start);
      if (t !== 0) return t;
      return a.type === b.type ? 0 : (a.type === 'deadline' ? -1 : 1);
    }),
  }));

  const accounts = sync.loadAccounts();
  const syncState = autotasks.load().sync;

  return {
    sources: {
      icsFeeds: feeds,
      google: Object.values(accounts).map((a) => ({
        email: a.email,
        role: a.role,
        calendar: a.calendar,
        lastSync: (syncState[a.email] || {}).calendarAt || null,
        lastError: (syncState[a.email] || {}).lastError || null,
      })),
    },
    connected: Object.values(accounts).some((a) => a.calendar) || calendar.loadFeeds().length > 0,
    from: from.toISOString(),
    to: to.toISOString(),
    days: sorted,
    suggestions,
    groups: groups.summary(gstate),
    labelTypes: Object.fromEntries(Object.entries(labels.TYPES).map(([k, v]) => [k, v.name])),
  };
}

/* ---------------------------------- auth --------------------------------- */

function isLoopbackAddress(addr) {
  const a = String(addr || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/**
 * Writes need the token when one is configured - except from this machine.
 *
 * Anything that can reach 127.0.0.1 is already running on this PC and could
 * read the token out of engine-config.json anyway, so asking the desktop app
 * for it buys no security and costs a password box. A phone coming in over
 * Tailscale arrives from a 100.x address and still has to prove itself.
 */
function writeAllowed(cfg, req, body) {
  if (!cfg.token) return true;
  if (isLoopbackAddress(req.socket && req.socket.remoteAddress)) return true;
  const given = req.headers['x-ratchet-token'] || body.token || '';
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(cfg.token));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * What the in-app guide needs to give exact setup steps: which computer this
 * is, where its files are, and the addresses a phone could use to reach it.
 * Read-only. Only a request from this machine gets the folder and addresses;
 * a phone already knows the address it came in on.
 */
function setupInfo(cfg, req) {
  const local = isLoopbackAddress(req.socket && req.socket.remoteAddress);
  const base = { local, port: cfg.port, tokenSet: !!cfg.token };
  if (!local) return base;

  const bindHosts = (Array.isArray(cfg.bindHost) ? cfg.bindHost : [cfg.bindHost]).filter(Boolean).map(String);
  const addresses = [];
  const present = new Set();
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      present.add(n.address);
      if (n.internal || (n.family !== 'IPv4' && n.family !== 4)) continue;
      const [a, b] = n.address.split('.').map(Number);
      // 100.64.0.0/10 is Tailscale's range; the private ranges are a home or school network.
      const kind = a === 100 && b >= 64 && b <= 127 ? 'tailscale'
        : a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ? 'lan' : null;
      if (!kind || n.address.startsWith('169.254.')) continue;
      addresses.push({ address: n.address, kind, iface: name, open: bindHosts.includes(n.address) });
    }
  }
  // A bindHost the computer no longer has: Tailscale is off, or the router handed out a new address.
  const missing = bindHosts.filter((h) => !isLoopback(h) && h !== '0.0.0.0' && !present.has(h));
  return { ...base, platform: process.platform, engineDir: __dirname, bindHosts, addresses, missing };
}

function redirectUri(cfg) {
  return `http://127.0.0.1:${cfg.port}/oauth/callback`;
}

/* -------------------------------- google --------------------------------- */

function googleStatus(cfg) {
  const client = oauth.loadClient();
  const tokens = oauth.loadTokens();
  const state = autotasks.load();
  const accounts = sync.loadAccounts();

  return {
    client: client ? (client.error ? { ok: false, error: client.error } : { ok: true, file: client.file }) : { ok: false, error: null },
    redirectUri: redirectUri(cfg),
    syncing: sync.isRunning(),
    everyMinutes: sync.loadSettings().syncEveryMinutes,
    accounts: Object.values(accounts).map((a) => {
      const s = state.sync[a.email] || {};
      return {
        email: a.email,
        role: a.role,
        homework: !!a.homework,
        replies: !!a.replies,
        calendar: !!a.calendar,
        events: a.events !== false,
        connectedAt: a.connectedAt,
        hasToken: !!(tokens[a.email] && tokens[a.email].refresh_token),
        lastSync: s.lastSync || null,
        lastError: s.lastError || null,
        needsReconnect: !!s.needsReconnect,
        eventCount: s.eventCount ?? null,
        waitingCount: s.waitingCount ?? null,
      };
    }),
    // Counted, not listed: the dashboard shows the resulting tasks, and this
    // endpoint has no business returning subjects of emails.
    captured: {
      homework: Object.values(state.homework).filter((h) => !h.dismissed).length,
      dismissed: Object.values(state.homework).filter((h) => h.dismissed).length,
    },
  };
}

function callbackPage(title, message, ok) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mellow</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7fc;color:#13233a;
    font:15px/1.5 -apple-system,"Segoe UI",Roboto,system-ui,sans-serif}
  .card{max-width:460px;margin:24px;padding:26px 28px;background:#fff;border:1px solid #dbe4f0;border-top:4px solid #1d5fd1;border-radius:12px}
  h1{font-size:20px;margin:0 0 8px;color:${ok ? '#1d5fd1' : '#c0392b'}}
  p{margin:0 0 14px;color:#5b6b82} a{color:#1d5fd1}
  @media (prefers-color-scheme:dark){body{background:#0d1b2e;color:#eaf1fb}.card{background:#13243b;border-color:#23395a}p{color:#9fb2cc}a{color:#6ea8ff}}
</style>
<div class="card"><h1>${escHtml(title)}</h1><p>${message}</p>
<p><a href="/#accounts">Back to Mellow</a></p></div>
${ok ? '<script>setTimeout(function(){location.href="/#accounts"},2500)</script>' : ''}`;
}

async function handleCallback(req, res, cfg, url) {
  if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
    return sendHtml(res, 403, callbackPage('Connect from the PC', 'Google accounts can only be connected from the computer running Mellow.', false));
  }

  const err = url.searchParams.get('error');
  if (err) {
    const why = err === 'access_denied'
      ? 'You declined, or your school does not allow this app to read the account. Nothing was connected.'
      : escHtml(oauth.explain({ error: err }, ''));
    return sendHtml(res, 400, callbackPage('Not connected', why, false));
  }

  const pending = oauth.takePending(url.searchParams.get('state') || '');
  const code = url.searchParams.get('code');
  if (!pending || !code) {
    return sendHtml(res, 400, callbackPage('That sign-in expired',
      'Start again from the Accounts section. Sign-ins time out after fifteen minutes.', false));
  }

  const client = oauth.loadClient();
  if (!client || client.error) {
    return sendHtml(res, 500, callbackPage('Google client missing', 'The client file is not in the engine folder any more.', false));
  }

  const ex = await oauth.exchangeCode(client, code, pending.verifier, pending.redirectUri);
  if (!ex.ok) {
    log(`google connect failed: ${ex.error}`);
    return sendHtml(res, 400, callbackPage('Not connected', escHtml(ex.error), false));
  }
  if (!ex.tokens.refresh_token) {
    return sendHtml(res, 400, callbackPage('Not connected',
      'Google did not issue a long-lived token. Remove Mellow at myaccount.google.com/permissions and connect again.', false));
  }

  // Which account did they actually pick? Ask Gmail rather than trusting the
  // role button they clicked, since the account chooser is Google's.
  let email;
  try {
    const profile = await profileForToken(ex.tokens.access_token);
    email = String(profile.emailAddress).toLowerCase();
  } catch (e) {
    return sendHtml(res, 400, callbackPage('Not connected', escHtml(`Could not read the account: ${e.message}`), false));
  }

  oauth.setTokens(email, ex.tokens);
  const acct = sync.addAccount(email, pending.role);
  log(`google connected: ${email} as ${acct.role}`);

  // First sync straight away, in the background, so the calendar is filled
  // by the time you are back on the dashboard.
  sync.syncAll(log).catch((e) => log(`sync after connect failed: ${e.message}`));

  return sendHtml(res, 200, callbackPage('Connected',
    `<b>${escHtml(email)}</b> is connected as your <b>${escHtml(acct.role)}</b> account. ` +
    'Mellow can read its mail and calendar, and cannot change either. The first sync has started.', true));
}

/* -------------------------------- handlers ------------------------------- */

async function handle(req, res, cfg) {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  if (route === '/' || route === '/index.html') {
    let html;
    try {
      html = fs.readFileSync(DASHBOARD, 'utf8');
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end(`Dashboard missing at ${DASHBOARD}`);
    }
    return sendHtml(res, 200, html);
  }

  // A fixed list, not a directory served wholesale. tasks.json, history.json
  // and google-tokens.json live in this folder too, and nothing should be able
  // to ask for them by guessing a filename.
  const STATIC = {
    '/icon-180.png': 'image/png',
    '/icon-192.png': 'image/png',
    '/icon-512.png': 'image/png',
    '/favicon.png': 'image/png',
    '/favicon.ico': 'image/png',
  };

  if (STATIC[route]) {
    const name = route === '/favicon.ico' ? 'favicon.png' : route.slice(1);
    try {
      const buf = fs.readFileSync(path.join(__dirname, name));
      res.writeHead(200, {
        'Content-Type': STATIC[route],
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=86400',
      });
      return res.end(buf);
    } catch (e) {
      res.writeHead(404); return res.end('not found');
    }
  }

  if (route === '/manifest.webmanifest') {
    return sendJson(res, 200, {
      name: 'Mellow',
      short_name: 'Mellow',
      description: 'Your schedule, and what you have to get done',
      start_url: '/',
      display: 'standalone',
      background_color: '#050506',
      theme_color: '#050506',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  }

  if (route === '/api/setup') {
    return sendJson(res, 200, setupInfo(cfg, req));
  }

  if (route === '/api/enforcement') {
    return sendJson(res, 200, currentState(cfg).enforcement);
  }

  if (route === '/api/state') {
    return sendJson(res, 200, { ...currentState(cfg), tokenRequired: !!cfg.token });
  }

  if (route === '/api/calendar') {
    // Capped so a bad query cannot ask for two centuries of weekly lectures.
    const days = Math.min(62, Math.max(1, parseInt(url.searchParams.get('days'), 10) || 14));
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(url.searchParams.get('from') || '');
    const from = m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
    return sendJson(res, 200, await calendarPayload(cfg, days, from));
  }

  /* things that stay private to this PC and devices with the token */

  if (req.method === 'GET' && (route.startsWith('/api/ai/') || route.startsWith('/api/assistant') || route.startsWith('/api/drops') || route === '/api/health' || route === '/api/versions' || route === '/api/updates')) {
    // Conversations and dropped files are as private as the mail they came
    // from: another device needs the token even to read them.
    if (!writeAllowed(cfg, req, {})) return sendJson(res, 401, { error: 'bad or missing token' });
    if (route === '/api/ai/status') return sendJson(res, 200, claude.status());
    if (route === '/api/drops') {
      const list = drops.list();
      const existing = existingForDrops(list);
      return sendJson(res, 200, { drops: list.map((d) => drops.markExisting(d, existing)), folders: drops.allFolders() });
    }
    if (route === '/api/drops/file') {
      const f = drops.rawFile(url.searchParams.get('id') || '');
      if (!f) return sendJson(res, 404, { error: 'That file is no longer there.' });
      // PDFs and pictures open in the browser. Anything that is text is sent as
      // plain text, so a dropped web page is shown, never run on this origin.
      const textual = ['text', 'html', 'ics', 'csv', 'ofx', 'rtf'].includes(f.how);
      const inline = f.how === 'pdf' || f.how === 'image' || textual;
      res.writeHead(200, {
        'Content-Type': f.how === 'pdf' ? 'application/pdf' : f.how === 'image' ? f.mime : textual ? 'text/plain; charset=utf-8' : 'application/octet-stream',
        'Content-Length': fs.statSync(f.file).size,
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      });
      return fs.createReadStream(f.file).pipe(res);
    }
    if (route === '/api/drops/one') {
      const d = drops.getDrop(url.searchParams.get('id') || '');
      return d ? sendJson(res, 200, d) : sendJson(res, 404, { error: 'That file is no longer there.' });
    }
    if (route === '/api/health') return sendJson(res, 200, health.getHealth());
    if (route === '/api/updates') {
      // Answered from what was last checked; a stale check runs in the background.
      updates.check().catch(() => {});
      return sendJson(res, 200, { ...updates.status(), onPc: isLoopbackAddress(req.socket && req.socket.remoteAddress) });
    }
    if (route === '/api/versions') {
      try {
        return sendJson(res, 200, { ...versions.list(), onPc: isLoopbackAddress(req.socket && req.socket.remoteAddress) });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }
    if (route === '/api/assistant/list') return sendJson(res, 200, { conversations: assistant.listConvs(), ai: claude.status() });
    if (route === '/api/assistant') {
      const c = assistant.loadConv(url.searchParams.get('id') || '');
      return c ? sendJson(res, 200, assistant.publicConv(c)) : sendJson(res, 404, { error: 'That conversation is gone.' });
    }
  }

  if (route === '/api/news') {
    return sendJson(res, 200, await news.getNews(url.searchParams.get('source') || '', {
      force: url.searchParams.get('refresh') === '1',
    }));
  }

  if (route === '/api/stocks') {
    return sendJson(res, 200, await stocks.getStocks());
  }

  if (route === '/api/stocks/history') {
    return sendJson(res, 200, await stocks.getHistory(url.searchParams.get('symbols') || '', url.searchParams.get('range') || '1mo'));
  }

  if (route === '/api/finance') {
    return sendJson(res, 200, await finance.getFinance());
  }

  if (route === '/api/finance/brief') {
    return sendJson(res, 200, await finance.getBrief({ force: url.searchParams.get('refresh') === '1' }));
  }

  if (route === '/api/art') {
    return sendJson(res, 200, { folder: ART_DIR, images: ownArtwork() });
  }

  if (route.startsWith('/art/')) {
    let name = '';
    try { name = decodeURIComponent(route.slice(5)); } catch (_) {}
    return sendArtwork(res, name);
  }

  if (route === '/api/google/status') {
    return sendJson(res, 200, googleStatus(cfg));
  }

  if (route === '/oauth/callback') {
    return handleCallback(req, res, cfg, url);
  }

  if (req.method !== 'POST') {
    return sendJson(res, 404, { error: 'not found' });
  }

  const body = await readBody(req, route === '/api/drops' ? 34 * 1024 * 1024 : route === '/api/health/import' ? 16 * 1024 * 1024
    : route.startsWith('/api/assistant') || route === '/api/organize' ? 512 * 1024 : 64 * 1024);
  if (body._tooLarge) return sendJson(res, 413, { error: route === '/api/drops' ? 'That file is too big. The limit is 24 MB.' : route === '/api/health/import' ? 'That export is too big to import in one go.' : 'That is too long.' });

  if (!writeAllowed(cfg, req, body)) {
    return sendJson(res, 401, { error: 'bad or missing token' });
  }

  const loopback = isLoopbackAddress(req.socket && req.socket.remoteAddress);

  /* the greeting's name, from the guide */

  if (route === '/api/profile') {
    const name = String(body.name == null ? '' : body.name).replace(/[\u0000-\u001f"\\<>]/g, '').trim().slice(0, 40);
    // Only the value changes, so the notes and spacing in engine-config.json survive.
    let text = '';
    try { text = fs.readFileSync(store.CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''); } catch (_) {}
    const pattern = /("name"\s*:\s*")[^"]*(")/;
    if (text && pattern.test(text)) {
      const tmp = `${store.CONFIG_FILE}.tmp`;
      fs.writeFileSync(tmp, text.replace(pattern, (m, a, b) => a + name + b));
      fs.renameSync(tmp, store.CONFIG_FILE);
    } else {
      store.writeJson(store.CONFIG_FILE, { ...store.readJson(store.CONFIG_FILE, {}), name });
    }
    cfg.name = name;
    log(`profile name ${name ? 'set' : 'cleared'}`);
    return sendJson(res, 200, { ok: true, state: currentState(cfg) });
  }

  /* AI settings */

  if (route === '/api/ai/key') {
    // A key typed on a phone would cross the network to get here. Only the PC.
    if (!loopback) return sendJson(res, 400, { error: 'Add the API key from the PC running Mellow.' });
    try {
      claude.saveKey(body.key);
      log(`ai: key ${body.key ? 'saved' : 'removed'}`);
      return sendJson(res, 200, { ok: true, ai: claude.status() });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (route === '/api/ai/settings') {
    claude.saveSettings(body);
    return sendJson(res, 200, { ok: true, ai: claude.status() });
  }

  /* dropped files */

  if (route === '/api/drops') {
    try {
      const d = drops.intake({ name: body.name, data: body.data, section: body.section }, log);
      log(`drop ${d.id}: received (${d.mime}, ${Math.round(d.size / 1024)} KB, ${d.section})`);
      return sendJson(res, 200, { ok: true, drop: d });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (route === '/api/drops/apply') {
    try {
      const r = drops.apply(String(body.id || ''), Array.isArray(body.choices) ? body.choices : [], { counts: body.counts === true });
      log(`drop ${body.id}: added ${r.added.events} events, ${r.added.deadlines} deadlines, ${r.added.finance} finance`);
      return sendJson(res, 200, { ok: true, ...r, drop: drops.getDrop(String(body.id)), state: currentState(cfg) });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (route === '/api/drops/move') {
    try {
      const d = drops.moveDrop(String(body.id || ''), String(body.folder || ''));
      return sendJson(res, 200, { ok: true, drop: d });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (route === '/api/drops/folder') {
    try {
      const folder = drops.createFolder(body.name);
      return sendJson(res, 200, { ok: true, folder, folders: drops.allFolders() });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (route === '/api/drops/folder/delete') {
    try {
      const r = drops.deleteFolder(String(body.id || ''));
      return sendJson(res, 200, { ok: true, ...r, folders: drops.allFolders() });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (route === '/api/drops/dismiss') {
    try { drops.dismiss(String(body.id || '')); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/api/drops/rescan') {
    const d = drops.getDrop(String(body.id || ''));
    if (!d) return sendJson(res, 400, { error: 'That file is no longer there.' });
    drops.scan(d.id, log).catch((e) => log(`drop ${d.id}: rescan failed: ${e.message}`));
    return sendJson(res, 200, { ok: true });
  }

  /* Organize page: sort what's on a page into groups. Changes nothing. */

  if (route === '/api/organize') {
    try {
      return sendJson(res, 200, await organizer.organize({ page: body.page, instruction: body.instruction, items: body.items }));
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  /* the assistant */

  if (route.startsWith('/api/assistant/')) {
    const ctx = {
      loopback,
      log,
      state: () => currentState(cfg),
      calendar: (days, from) => calendarPayload(cfg, days, from),
      news: () => news.getNews(''),
    };
    try {
      if (route === '/api/assistant/send') {
        return sendJson(res, 200, assistant.send({ id: body.id || null, text: body.text, fileIds: body.fileIds, page: body.page, voice: body.voice === true }, ctx));
      }
      if (route === '/api/assistant/decide') {
        return sendJson(res, 200, assistant.decide({ id: String(body.id || ''), decisions: body.decisions, all: typeof body.all === 'boolean' ? body.all : undefined }, ctx));
      }
      if (route === '/api/assistant/undo') {
        if (!loopback) return sendJson(res, 400, { error: 'Undo app changes from the PC running Mellow.' });
        const meta = assistant.undoChange(body.changeId, ctx);
        return sendJson(res, 200, { ok: true, path: meta.path });
      }
      if (route === '/api/assistant/delete') {
        assistant.deleteConv(String(body.id || ''));
        return sendJson(res, 200, { ok: true, conversations: assistant.listConvs() });
      }
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    return sendJson(res, 404, { error: 'not found' });
  }

  /* news subscriptions */

  if (route === '/api/news/subscription') {
    try {
      news.setSubscription(String(body.id || ''), body.on === true);
      log(`news: ${body.on ? 'subscribed to' : 'unsubscribed from'} ${body.id}`);
      return sendJson(res, 200, { ok: true, subscriptions: news.subscriptionStatus() });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (route === '/api/news/suggestion/dismiss') {
    news.dismissDetected(String(body.id || ''));
    return sendJson(res, 200, { ok: true, subscriptions: news.subscriptionStatus() });
  }

  /* google accounts */

  if (route === '/api/google/connect') {
    if (!isLoopbackAddress(req.socket && req.socket.remoteAddress)) {
      return sendJson(res, 400, { error: 'Connect Google accounts from the PC running Mellow. The sign-in has to come back to this machine.' });
    }
    const client = oauth.loadClient();
    if (!client || client.error) {
      return sendJson(res, 400, { error: client && client.error ? client.error : 'No Google client file yet. See GOOGLE-SETUP.md.' });
    }
    const role = body.role === 'school' ? 'school' : 'personal';
    return sendJson(res, 200, { url: oauth.beginSignIn(client, redirectUri(cfg), role) });
  }

  if (route === '/api/google/sync') {
    const result = await sync.syncAll(log);
    return sendJson(res, 200, { ok: true, result, status: googleStatus(cfg), state: currentState(cfg) });
  }

  if (route === '/api/google/account') {
    const updated = sync.updateAccount(String(body.email || ''), body);
    if (!updated) return sendJson(res, 400, { error: 'No such account.' });
    log(`google account ${updated.email}: role=${updated.role} homework=${updated.homework} replies=${updated.replies} calendar=${updated.calendar} events=${updated.events !== false}`);
    return sendJson(res, 200, { ok: true, status: googleStatus(cfg) });
  }

  if (route === '/api/google/disconnect') {
    const email = String(body.email || '');
    if (!sync.loadAccounts()[email]) return sendJson(res, 400, { error: 'No such account.' });
    sync.removeAccount(email);
    log(`google disconnected: ${email}`);
    return sendJson(res, 200, { ok: true, status: googleStatus(cfg), state: currentState(cfg) });
  }

  /* captured homework */

  if (route === '/api/auto/confirm' || route === '/api/auto/dismiss' || route === '/api/auto/restore') {
    const state = autotasks.load();
    const patch = route === '/api/auto/confirm' ? { confirmed: true, dismissed: false }
      : route === '/api/auto/dismiss' ? { dismissed: true }
      : { dismissed: false };
    const item = autotasks.setHomework(state, String(body.key || ''), patch);
    if (!item) return sendJson(res, 400, { error: 'That item is no longer there.' });
    autotasks.save(state);
    log(`${route.split('/').pop()}: ${item.key}`);
    return sendJson(res, 200, { ok: true, state: currentState(cfg) });
  }

  /* events found in email */

  if (route === '/api/events/add' || route === '/api/events/dismiss') {
    const state = autotasks.load();
    const add = route === '/api/events/add';
    const item = autotasks.setEvent(state, String(body.key || ''), add
      ? { confirmed: true, dismissed: false, movedAt: null }
      : { confirmed: false, dismissed: true });
    if (!item) return sendJson(res, 400, { error: 'That event is no longer there.' });
    autotasks.save(state);
    log(`event ${add ? 'added' : 'dismissed'}: ${item.key}`);
    return sendJson(res, 200, { ok: true });
  }

  /* groups you are in, and calendar labels */

  if (route === '/api/groups/decide' || route === '/api/groups/add') {
    try {
      const gstate = groups.load();
      const g = route === '/api/groups/add'
        ? groups.addGroup(gstate, body.name, body.kind)
        : groups.decide(gstate, String(body.id || ''), body.join === true, body);
      groups.save(gstate);
      log(`group ${g.id}: ${g.status}`);
      return sendJson(res, 200, { ok: true, groups: groups.summary(gstate) });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (route === '/api/labels/set') {
    try {
      const gstate = groups.load();
      const o = groups.setLabel(gstate, String(body.title || ''), body);
      groups.save(gstate);
      return sendJson(res, 200, { ok: true, override: o });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  /* waiting on a reply */

  if (route === '/api/emails/dismiss') {
    const state = autotasks.load();
    const keys = body.all ? 'all' : (Array.isArray(body.keys) ? body.keys.map(String) : []);
    const n = autotasks.dismissReplies(state, keys);
    autotasks.save(state);
    log(`emails dismissed: ${n}`);
    return sendJson(res, 200, { ok: true, dismissed: n, state: currentState(cfg) });
  }

  if (route === '/api/emails/undo') {
    const state = autotasks.load();
    const n = autotasks.undismissReplies(state, 5);
    autotasks.save(state);
    if (!n) return sendJson(res, 400, { error: 'Nothing to undo from the last five minutes.' });
    return sendJson(res, 200, { ok: true, restored: n, state: currentState(cfg) });
  }

  /* finance */

  if (route.startsWith('/api/finance/')) {
    const what = route.slice('/api/finance/'.length);
    const kind = String(body.kind || '');
    try {
      let note;
      if (what === 'save') {
        if (!finance.KINDS[kind] || !body.item || typeof body.item !== 'object') throw new Error('Nothing to save.');
        const item = await finance.change((data) => finance.upsert(data, kind, body.item));
        note = `${body.item.id ? 'changed' : 'added'} ${finance.KINDS[kind].label} ${item.id}`;
      } else if (what === 'delete') {
        await finance.change((data) => finance.remove(data, kind, String(body.id || '')));
        note = `deleted ${kind} ${body.id}`;
      } else if (what === 'paid') {
        const r = await finance.change((data) => finance.markPaid(data, String(body.id || ''), body.occurrence || null, { log: body.log !== false, amount: body.amount }));
        note = `bill ${r.bill.id} ${r.occurrence} marked ${r.bill.income ? 'received' : 'paid'}`;
      } else if (what === 'unpaid') {
        await finance.change((data) => finance.unmarkPaid(data, String(body.id || ''), String(body.occurrence || '')));
        note = `unmarked bill ${body.id} ${body.occurrence}`;
      } else if (what === 'ai') {
        const share = await finance.change((data) => finance.setAiShare(data, body.share || {}));
        note = `AI may read: ${Object.keys(share).filter((k) => share[k]).join(', ') || 'nothing'}`;
      } else {
        return sendJson(res, 404, { error: 'not found' });
      }
      // Ids and dates only. Amounts and names stay out of the log.
      log(`finance: ${note}`);
      return sendJson(res, 200, { ok: true, finance: await finance.getFinance() });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  /* health */

  if (route.startsWith('/api/health/')) {
    const what = route.slice('/api/health/'.length);
    try {
      let note;
      if (what === 'save') {
        const item = health.change((data) => health.upsert(data, String(body.kind || ''), body.item, body.today));
        note = `${body.item && body.item.id ? 'changed' : 'added'} ${body.kind} ${item.id}`;
      } else if (what === 'delete') {
        health.change((data) => health.remove(data, String(body.kind || ''), String(body.id || '')));
        note = `deleted ${body.kind} ${body.id}`;
      } else if (what === 'taken') {
        health.change((data) => health.setTaken(data, body.date, String(body.id || ''), body.on === true));
        note = `supplement ${body.id} ${body.on ? 'taken' : 'not taken'} ${body.date}`;
      } else if (what === 'settings') {
        health.change((data) => health.setSettings(data, body.settings));
        note = 'settings changed';
      } else if (what === 'import') {
        const days = body.source === 'whoop' ? health.parseWhoop(String(body.csv || '')) : body.days;
        const counts = health.change((data) => health.importDays(data, String(body.source || ''), days));
        note = `imported ${body.source}: ${counts.days} days`;
        log(`health: ${note}`);
        return sendJson(res, 200, { ok: true, counts, health: health.getHealth() });
      } else {
        return sendJson(res, 404, { error: 'not found' });
      }
      // Ids only. What you ate and weigh stays out of the log.
      log(`health: ${note}`);
      return sendJson(res, 200, { ok: true, health: health.getHealth() });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  /* versions of the app */

  if (route.startsWith('/api/versions/')) {
    const what = route.slice('/api/versions/'.length);
    // Code on this PC changes, so only this PC may do it, like approving an app change.
    if (!loopback && what !== 'save') return sendJson(res, 400, { error: 'Change versions from the PC running Mellow.' });
    try {
      let extra = {};
      if (what === 'save') {
        extra.saved = versions.save({ name: body.name, kind: 'saved' });
        log(`versions: saved ${extra.saved.id}`);
      } else if (what === 'restore') {
        extra.result = versions.restore(String(body.id || ''), log);
      } else if (what === 'delete') {
        versions.remove(String(body.id || ''));
      } else if (what === 'rename') {
        versions.rename(String(body.id || ''), body.name);
      } else {
        return sendJson(res, 404, { error: 'not found' });
      }
      return sendJson(res, 200, { ok: true, ...extra, ...versions.list(), onPc: loopback });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  /* updates: a newer Mellow from its GitHub releases */

  if (route === '/api/updates/check') {
    return sendJson(res, 200, { ...(await updates.check({ force: true })), onPc: loopback });
  }

  if (route === '/api/updates/apply') {
    if (!loopback) return sendJson(res, 400, { error: 'Update from the PC running Mellow.' });
    try {
      const r = await updates.apply({ log, versions, checkSyntax: require('./lib/ai/assistant').checkSyntax });
      sendJson(res, 200, { ok: true, result: r });
      // Started from a start file: exit with the code that tells it to start the new version.
      if (r.restart) setTimeout(() => process.exit(updates.RESTART_CODE), 1200);
      return undefined;
    } catch (e) {
      log(`update failed: ${e.message}`);
      return sendJson(res, 400, { error: e.message });
    }
  }

  /* tasks */

  const task = allTasks().find((t) => t.id === body.taskId);
  if (!task) return sendJson(res, 400, { error: 'That task is no longer there. It may have just been cleared by a sync.' });

  if (route === '/api/complete') {
    // "Reply to 3 emails" is not satisfied by a click; clicking Done means
    // "I have dealt with these", which is a dismissal of those threads.
    if (task.doneAction === 'dismiss-replies') {
      const state = autotasks.load();
      const n = autotasks.dismissReplies(state, (task.threads || []).map((t) => t.key));
      autotasks.save(state);
      log(`emails handled: ${n}`);
      return sendJson(res, 200, { ok: true, state: currentState(cfg) });
    }

    // A task that asks for a note is asking you to prove you engaged with it.
    // Accepting an empty one turns the whole thing into a button you press.
    if (task.requiresNote) {
      const words = String(body.note || '').trim().split(/\s+/).filter(Boolean);
      const need = task.minNoteWords || 10;
      if (words.length < need) {
        return sendJson(res, 400, { error: `That one needs a note of at least ${need} words. You wrote ${words.length}.` });
      }
    }
    const rec = store.append(task.id, 'done', body.note);
    log(`done: ${task.id}${rec.note ? ` - "${rec.note}"` : ''}`);
    return sendJson(res, 200, { ok: true, record: rec, state: currentState(cfg) });
  }

  if (route === '/api/pass') {
    if (task.doneAction) {
      return sendJson(res, 400, { error: 'Passes are for tasks, not for email. Mark the ones that do not need a reply instead.' });
    }
    const history = store.loadHistory();
    const used = sched.passesUsed(history, new Date());
    if (used >= cfg.passesPerWeek) {
      return sendJson(res, 400, { error: `No passes left. ${used} of ${cfg.passesPerWeek} used in the last 7 days.` });
    }
    const rec = store.append(task.id, 'pass', body.note || '');
    log(`pass spent: ${task.id} (${used + 1}/${cfg.passesPerWeek} this week)`);
    return sendJson(res, 200, { ok: true, record: rec, state: currentState(cfg) });
  }

  if (route === '/api/undo') {
    const removed = store.undoRecent(task.id, 5);
    if (!removed) {
      return sendJson(res, 400, { error: 'Nothing to undo from the last five minutes.' });
    }
    log(`undo: ${task.id} (${removed.kind})`);
    return sendJson(res, 200, { ok: true, removed, state: currentState(cfg) });
  }

  return sendJson(res, 404, { error: 'not found' });
}

/* ---------------------------------- main --------------------------------- */

const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];

function isLoopback(host) {
  return LOOPBACK.includes(String(host));
}

function listenOn(handlerFn, host, port) {
  return new Promise((resolve) => {
    const server = http.createServer(handlerFn);
    server.once('error', (e) => resolve({ ok: false, host, error: e }));
    server.listen(port, host, () => resolve({ ok: true, host, server }));
  });
}

async function main() {
  const cfg = store.loadConfig();

  if (!fs.existsSync(store.TASKS_FILE)) {
    console.error(`No tasks.json at ${store.TASKS_FILE}. Nothing to enforce.`);
    process.exit(1);
  }

  const handler = (req, res) => {
    handle(req, res, cfg).catch((e) => {
      log(`ERROR ${req.method} ${req.url}: ${e.stack || e.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  };

  // Loopback is always bound, whatever else is. On Windows "localhost"
  // resolves to ::1 before 127.0.0.1 and a browser tries the IPv6 one first,
  // so both go on the list; and opening the port to a phone must never be the
  // thing that breaks the desktop shortcut pointing at localhost.
  const extra = (Array.isArray(cfg.bindHost) ? cfg.bindHost : [cfg.bindHost])
    .filter((h) => h && !isLoopback(h));
  const hosts = ['127.0.0.1', '::1', ...extra];

  const results = await Promise.all(hosts.map((h) => listenOn(handler, h, cfg.port)));
  const bound = results.filter((r) => r.ok);

  if (bound.length === 0) {
    const first = results[0].error;
    if (first.code === 'EADDRINUSE') {
      console.error(`Port ${cfg.port} is already in use. Is the engine already running?`);
    } else {
      console.error(first.message);
    }
    process.exit(1);
  }

  log('--------------------------------------------------');
  for (const r of bound) {
    const shown = r.host.includes(':') ? `[${r.host}]` : r.host;
    log(`Mellow engine listening on http://${shown}:${cfg.port}`);
  }
  for (const r of results.filter((x) => !x.ok)) {
    log(`Note: could not bind ${r.host} (${r.error.code}). The other address still works.`);
  }

  // The preset to go back to, taken once, before anyone has changed anything.
  try { if (versions.ensureOriginal()) log('versions: saved Mellow as it is now as "Original"'); } catch (e) { log(`versions: ${e.message}`); }

  // At boot the engine usually starts before Tailscale has its address, so a
  // Tailscale bindHost fails with EADDRNOTAVAIL. Keep trying every 20 seconds
  // until it comes up, so the phone and iPad work without a restart.
  const waiting = results.filter((r) => !r.ok && r.error && r.error.code === 'EADDRNOTAVAIL').map((r) => r.host);
  if (waiting.length) {
    log(`Waiting for ${waiting.join(', ')} to appear (Tailscale starting?). Retrying every 20s.`);
    const retry = setInterval(async () => {
      for (const h of waiting.slice()) {
        const r = await listenOn(handler, h, cfg.port);
        if (r.ok) {
          waiting.splice(waiting.indexOf(h), 1);
          log(`Now listening on http://${h}:${cfg.port} as well.`);
        } else if (r.error && r.error.code !== 'EADDRNOTAVAIL') {
          waiting.splice(waiting.indexOf(h), 1);
          log(`Gave up on ${h}: ${r.error.code || r.error.message}.`);
        }
      }
      if (!waiting.length) clearInterval(retry);
    }, 20000);
  }

  log(`Dashboard:   http://localhost:${cfg.port}/`);
  log(`Client polls http://localhost:${cfg.port}/api/enforcement`);
  log(`${store.loadTasks().length} manual task(s). Passes: ${cfg.passesPerWeek}/week.`);

  if (extra.length > 0) {
    if (cfg.token) {
      log(`Reachable from ${extra.join(', ')}. Writes from other devices need the token.`);
    } else {
      log('WARNING: the port is open beyond this machine and no token is set. ' +
          'Anyone who can reach it can mark your tasks done.');
    }
  }

  // Homework captured twice (an older reading of a calendar, a syllabus in
  // Files) is folded together once at startup; every later save does the same.
  try {
    const captured = autotasks.load();
    const before = JSON.stringify(captured.homework);
    const r = dedupe.dedupeHomework(captured, autotasks.doneKeys());
    if (JSON.stringify(captured.homework) !== before) {
      autotasks.save(captured, { skipDedupe: true });
      log(`homework: merged ${r.merged} duplicate(s), repaired ${r.repaired} title(s)`);
    }
  } catch (e) {
    log(`homework dedupe skipped: ${e.message}`);
  }

  const client = oauth.loadClient();
  const accounts = Object.keys(sync.loadAccounts());
  if (!client) log('Google: no client file yet - see GOOGLE-SETUP.md');
  else if (client.error) log(`Google: ${client.error}`);
  else log(`Google: client ${client.file}, ${accounts.length} account(s) connected`);

  // The sync timer. A short delay on startup lets the port settle first.
  const every = Math.max(2, Number(sync.loadSettings().syncEveryMinutes) || 10);
  const tick = () => sync.syncAll(log).catch((e) => log(`sync failed: ${e.stack || e.message}`));
  setTimeout(tick, 5000);
  setInterval(tick, every * 60000);

  // The morning money brief: built once a day after finance.json's morningHour,
  // so the headlines are waiting before the dashboard is even opened.
  const morning = () => finance.morningTick(log).catch((e) => log(`finance brief failed: ${e.message}`));
  setTimeout(morning, 20000);
  setInterval(morning, 10 * 60000);

  // Newer versions: checked a minute after starting, then every few hours. It only looks; installing is a click.
  const checkUpdates = () => updates.check().then((u) => { if (u.available) log(`update: Mellow ${u.latest.version} is available (this is ${u.current})`); }).catch(() => {});
  setTimeout(checkUpdates, 60000);
  setInterval(checkUpdates, 3 * 3600000);
  log(`Mellow ${updates.local().version}`);

  log(`Current level: ${currentState(cfg).enforcement.level}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { currentState, handle, isLoopback, allTasks, deadlinesBetween, calendarPayload };
