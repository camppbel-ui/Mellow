'use strict';
/**
 * sync.js - pull from each connected Google account, turn what comes back
 * into tasks and calendar entries, and remember enough not to redo the work.
 *
 * Runs every few minutes inside the engine, so it is careful about cost:
 * a message is classified once and never fetched again, and a thread is only
 * re-read when Google says something in it changed.
 */

const fs = require('fs');
const path = require('path');

const { Account, header, bodyText, isBulk, isAutomated } = require('./google/api');
const oauth = require('./google/oauth');
const homework = require('./extract/homework');
const eventsFromMail = require('./extract/events');
const replies = require('./extract/replies');
const autotasks = require('./autotasks');
const store = require('./store');
const news = require('./news');
const groups = require('./groups');
const finance = require('./finance');
const receipts = require('./ai/receipts');

const ROOT = path.join(__dirname, '..');
const ACCOUNTS_FILE = path.join(ROOT, 'google-accounts.json');
const SETTINGS_FILE = path.join(ROOT, 'google.json');
const CACHE_DIR = path.join(ROOT, 'google-cache');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

/* -------------------------------- settings ------------------------------- */

const DEFAULT_SETTINGS = {
  syncEveryMinutes: 10,
  // Enough either side of today for the month view to be full.
  calendarDaysAhead: 62,
  calendarDaysBehind: 35,
  homeworkLookbackDays: 21,
  repliesLookbackDays: 14,
  eventsLookbackDays: 14,
  groupsLookbackDays: 30,
  moneyLookbackDays: 60,
  // Far enough back to see a yearly subscription's last renewal.
  subscriptionLookbackDays: 400,
  replyWithinHours: 24,
  repliesCanShield: false,
  ladders: {},
};

function loadSettings() {
  const raw = readJson(SETTINGS_FILE, {});
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (raw[k] !== undefined) out[k] = raw[k];
  }
  return out;
}

/* -------------------------------- accounts ------------------------------- */

// What each role does by default. School is where homework comes from;
// both kinds of account can have email waiting on a reply.
const ROLE_DEFAULTS = {
  school: { homework: true, replies: true, calendar: true, events: true },
  personal: { homework: false, replies: true, calendar: true, events: true },
};

function loadAccounts() {
  const raw = readJson(ACCOUNTS_FILE, { accounts: {} });
  return raw.accounts || {};
}

function saveAccounts(accounts) {
  writeJson(ACCOUNTS_FILE, { accounts });
}

function addAccount(email, role) {
  const accounts = loadAccounts();
  const r = ROLE_DEFAULTS[role] ? role : 'personal';
  accounts[email] = {
    email,
    role: r,
    ...ROLE_DEFAULTS[r],
    ...(accounts[email] ? { homework: accounts[email].homework, replies: accounts[email].replies, calendar: accounts[email].calendar, events: accounts[email].events !== false } : {}),
    connectedAt: accounts[email] ? accounts[email].connectedAt : new Date().toISOString(),
  };
  saveAccounts(accounts);
  return accounts[email];
}

function updateAccount(email, patch) {
  const accounts = loadAccounts();
  if (!accounts[email]) return null;
  for (const k of ['role', 'homework', 'replies', 'calendar', 'events']) {
    if (patch[k] !== undefined) {
      accounts[email][k] = k === 'role' ? (ROLE_DEFAULTS[patch[k]] ? patch[k] : accounts[email].role) : !!patch[k];
    }
  }
  saveAccounts(accounts);
  return accounts[email];
}

function removeAccount(email) {
  const accounts = loadAccounts();
  delete accounts[email];
  saveAccounts(accounts);
  oauth.removeTokens(email);
  try { fs.unlinkSync(cacheFile(email)); } catch (_) {}
  const state = autotasks.load();
  autotasks.forgetAccount(state, email);
  autotasks.save(state);
}

/* ---------------------------------- cache -------------------------------- */

function cacheFile(email) {
  return path.join(CACHE_DIR, `${String(email).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

/** "2026-09-15" -> local midnight. new Date('2026-09-15') is UTC midnight, which is the previous evening in the US. */
function localDate(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function normalizeEvent(ev, cal) {
  if (!ev || ev.status === 'cancelled' || !ev.start) return null;
  const self = (ev.attendees || []).find((a) => a.self);
  if (self && self.responseStatus === 'declined') return null;

  const allDay = !!ev.start.date;
  const start = allDay ? localDate(ev.start.date) : new Date(ev.start.dateTime);
  const endRaw = ev.end || {};
  const end = allDay
    ? localDate(endRaw.date || ev.start.date)
    : new Date(endRaw.dateTime || ev.start.dateTime);
  if (Number.isNaN(start.getTime())) return null;

  return {
    id: ev.id,
    calendarId: cal.id,
    calendarName: cal.summaryOverride || cal.summary || '',
    color: cal.backgroundColor || null,
    title: ev.summary || '(no title)',
    description: String(ev.description || '').slice(0, 2000),
    location: ev.location || '',
    start,
    end,
    allDay,
    recurring: !!ev.recurringEventId,
    htmlLink: ev.htmlLink || '',
  };
}

function normalizeMessage(msg) {
  const h = (msg.payload && msg.payload.headers) || [];
  const from = header(h, 'From');
  const internal = Number(msg.internalDate);
  return {
    id: msg.id,
    threadId: msg.threadId,
    subject: header(h, 'Subject'),
    from,
    fromAddress: replies.addressOf(from),
    date: internal ? new Date(internal) : new Date(header(h, 'Date')),
    body: bodyText(msg.payload),
    snippet: msg.snippet || '',
    labels: msg.labelIds || [],
    bulk: isBulk(h),
  };
}

/** A message fetched with headers only: who, what about, which list. No body. */
function metadataMessage(msg) {
  const h = (msg.payload && msg.payload.headers) || [];
  const from = header(h, 'From');
  const internal = Number(msg.internalDate);
  return {
    id: msg.id,
    subject: header(h, 'Subject'),
    from,
    fromAddress: replies.addressOf(from),
    listId: header(h, 'List-Id'),
    snippet: msg.snippet || '',
    labels: msg.labelIds || [],
    date: internal ? new Date(internal) : null,
  };
}

/**
 * Headers of the unseen messages a search finds, a few per run. `seen` is
 * the per-account map of message ids already read, pruned to the window.
 */
async function newMetadata(api, q, seen, { max, fetchCap, headers, days, now, fail }) {
  const out = [];
  const ids = await api.listMessageIds(q, max);
  for (const id of ids) {
    if (seen[id]) continue;
    if (out.length >= fetchCap) break;
    try {
      out.push(metadataMessage(await api.getMessageMetadata(id, headers)));
      seen[id] = now.toISOString();
    } catch (e) {
      fail('Message', e);
      if (e.permanent) break;
    }
  }
  const cutoff = now.getTime() - (days + 30) * 86400000;
  for (const [id, at] of Object.entries(seen)) if (new Date(at).getTime() < cutoff) delete seen[id];
  return out;
}

function normalizeThread(meta) {
  const messages = (meta.messages || []).map((m) => {
    const h = (m.payload && m.payload.headers) || [];
    return {
      id: m.id,
      from: header(h, 'From'),
      to: header(h, 'To'),
      cc: header(h, 'Cc'),
      date: Number(m.internalDate) ? new Date(Number(m.internalDate)) : new Date(header(h, 'Date')),
      labels: m.labelIds || [],
      bulk: isBulk(h),
      autoSubmitted: isAutomated(h),
      snippet: m.snippet || '',
    };
  });
  const first = (meta.messages || [])[0];
  const subject = first ? header((first.payload && first.payload.headers) || [], 'Subject') : '';
  return { id: meta.id, subject, messages };
}

/* ---------------------------------- sync --------------------------------- */

function homeworkQuery(days) {
  return `newer_than:${days}d -category:promotions -category:social -in:sent -in:chats ` +
    '{assignment homework hw "problem set" pset quiz exam midterm project essay paper "lab report" ' +
    'due deadline submit submission from:instructure.com from:canvaslms.com from:gradescope.com}';
}

function repliesQuery(days) {
  return `in:inbox newer_than:${days}d -category:promotions -category:social -category:updates -category:forums -from:me`;
}

async function syncAccount(email, acct, state, settings, now, log) {
  const api = new Account(email);
  const status = state.sync[email] || (state.sync[email] = { seen: {}, threads: {} });
  status.seen = status.seen || {};
  status.threads = status.threads || {};
  const errors = [];
  const candidates = [];
  let permanent = false;

  const fail = (where, e) => {
    errors.push(`${where}: ${e.message}`);
    if (e.permanent) permanent = true;
  };

  // Every address you send as counts as "you" when deciding who replied last.
  // Re-checked once a day, in case you add an alias.
  if (!status.me || !status.meAt || now - new Date(status.meAt) > 86400000) {
    try {
      const profile = await api.profile();
      const aliases = await api.sendAs();
      status.me = [...new Set([String(profile.emailAddress).toLowerCase(), ...aliases])];
      status.meAt = now.toISOString();
    } catch (e) {
      fail('Profile', e);
    }
  }
  if (permanent) return finish();

  /* calendar */
  if (acct.calendar || acct.homework) {
    try {
      const cals = (await api.listCalendars()).filter((c) => c.selected !== false && !c.deleted && !c.hidden);
      const from = new Date(now.getTime() - Math.max(1, Number(settings.calendarDaysBehind) || 1) * 86400000);
      const to = new Date(now.getTime() + settings.calendarDaysAhead * 86400000);
      const events = [];
      for (const cal of cals) {
        try {
          for (const ev of await api.listEvents(cal.id, from, to)) {
            const n = normalizeEvent(ev, cal);
            if (n) events.push(n);
          }
        } catch (e) {
          // One unreadable shared calendar should not blank the others.
          errors.push(`Calendar "${cal.summary}": ${e.message}`);
          if (e.permanent) { permanent = true; break; }
        }
      }
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      writeJson(cacheFile(email), { account: email, fetchedAt: now.toISOString(), events });
      status.calendarAt = now.toISOString();
      status.eventCount = events.length;

      if (acct.homework) {
        for (const ev of events) {
          const c = homework.fromEvent(ev, email);
          if (c) candidates.push(c);
        }
      }
    } catch (e) {
      fail('Calendar', e);
    }
  }
  if (permanent) return finish();

  /* homework from mail */
  if (acct.homework) {
    try {
      const ids = await api.listMessageIds(homeworkQuery(settings.homeworkLookbackDays), 50);
      let fetched = 0;
      for (const id of ids) {
        if (status.seen[id]) continue;
        // A cap per run, so a first sync against a busy inbox cannot spend
        // minutes blocking the next one. Whatever is left is picked up next time.
        if (fetched >= 40) break;
        fetched++;
        try {
          const msg = normalizeMessage(await api.getMessage(id));
          const c = homework.fromEmail(msg, email);
          if (c) candidates.push(c);
          status.seen[id] = now.toISOString();
        } catch (e) {
          fail('Message', e);
          if (e.permanent) break;
        }
      }
      // Forget classifications older than the lookback window plus a margin.
      const cutoff = now.getTime() - (settings.homeworkLookbackDays + 30) * 86400000;
      for (const [id, at] of Object.entries(status.seen)) {
        if (new Date(at).getTime() < cutoff) delete status.seen[id];
      }
      status.mailAt = now.toISOString();
    } catch (e) {
      fail('Mail', e);
    }
  }
  if (permanent) return finish();

  /* events from mail - on unless switched off for this account */
  if (acct.events !== false) {
    try {
      status.seenEvents = status.seenEvents || {};
      const ids = await api.listMessageIds(eventsFromMail.query(settings.eventsLookbackDays), 40);
      const found = [];
      let fetched = 0;
      for (const id of ids) {
        if (status.seenEvents[id]) continue;
        if (fetched >= 30) break;
        fetched++;
        try {
          const msg = normalizeMessage(await api.getMessage(id));
          const c = eventsFromMail.fromEmail(msg, email, now);
          if (c) found.push(c);
          status.seenEvents[id] = now.toISOString();
        } catch (e) {
          fail('Message', e);
          if (e.permanent) break;
        }
      }
      const cutoff = now.getTime() - (settings.eventsLookbackDays + 30) * 86400000;
      for (const [id, at] of Object.entries(status.seenEvents)) {
        if (new Date(at).getTime() < cutoff) delete status.seenEvents[id];
      }
      const r = autotasks.mergeEvents(state, found, now);
      if (r.added || r.updated) log(`sync ${email}: ${r.added} event suggestion(s), ${r.updated} moved`);
      status.eventsAt = now.toISOString();
    } catch (e) {
      fail('Events', e);
    }
  }
  if (permanent) return finish();

  /* waiting on a reply */
  if (acct.replies) {
    try {
      const threads = await api.listThreads(repliesQuery(settings.repliesLookbackDays), 50);
      const waiting = [];
      const present = new Set();
      for (const t of threads) {
        present.add(t.id);
        let d = status.threads[t.id];
        if (!d || d.historyId !== t.historyId) {
          const norm = normalizeThread(await api.getThreadMetadata(t.id));
          const r = replies.awaitingReply(norm, status.me || [email]);
          d = {
            historyId: t.historyId,
            waiting: r.waiting,
            since: r.since ? r.since.toISOString() : null,
            from: r.from || '',
            subject: norm.subject || '',
            reason: r.reason,
          };
          status.threads[t.id] = d;
        }
        if (d.waiting) waiting.push({ threadId: t.id, since: d.since, from: d.from, subject: d.subject });
      }
      for (const id of Object.keys(status.threads)) {
        if (!present.has(id)) delete status.threads[id];
      }
      autotasks.setReplies(state, email, waiting, now);
      status.repliesAt = now.toISOString();
      status.waitingCount = waiting.length;
    } catch (e) {
      fail('Replies', e);
    }
  } else {
    autotasks.setReplies(state, email, [], now);
  }

  /* which papers you subscribe to, suggested from receipts and renewals */
  if (acct.replies || acct.homework) {
    try {
      await news.detectFromMail(api, email, now);
    } catch (_) {
      // A suggestion is never worth a sync error.
    }
  }
  if (permanent) return finish();

  /* the groups you might be in: SAAC meetings, club lists, "welcome to the team" */
  if (acct.events !== false) {
    try {
      status.seenGroups = status.seenGroups || {};
      const msgs = await newMetadata(api, groups.query(settings.groupsLookbackDays), status.seenGroups, {
        max: 50, fetchCap: 25, headers: ['Subject', 'From', 'List-Id'], days: settings.groupsLookbackDays, now, fail,
      });
      // Loaded after the fetches, so nothing written meanwhile is overwritten.
      const gstate = groups.load();
      const r = groups.observe(gstate, msgs.flatMap((m) => groups.signalsFromEmail(m)), now);
      if (r.changed) groups.save(gstate);
      if (r.became.length) log(`sync ${email}: ${r.became.length} group(s) to ask about`);
    } catch (e) {
      if (e.permanent) fail('Groups', e);
      else log(`sync ${email}: groups skipped: ${e.message}`);
    }
  }
  if (permanent) return finish();

  /* accounts of your own: a deposit at Coinbase, a trade at E*TRADE, a sign-in at Venmo */
  if (acct.replies || acct.homework) {
    try {
      status.seenMoney = status.seenMoney || {};
      const msgs = await newMetadata(api, finance.institutionQuery(settings.moneyLookbackDays), status.seenMoney, {
        max: 30, fetchCap: 20, headers: ['Subject', 'From'], days: settings.moneyLookbackDays, now, fail,
      });
      if (msgs.length) {
        const data = finance.load();
        const made = msgs.map((m) => finance.detectFromEmail(data, m)).filter(Boolean);
        // Counted, not named: which services you use stays out of the log.
        if (made.length) { finance.save(data); log(`sync ${email}: ${made.length} account(s) found in email`); }
      }
    } catch (e) {
      if (e.permanent) fail('Accounts', e);
      else log(`sync ${email}: account check skipped: ${e.message}`);
    }
  }
  if (permanent) return finish();

  /* subscriptions: receipts, renewals, trials and cancellations, read by Claude */
  if (acct.replies || acct.homework) {
    try {
      status.seenReceipts = status.seenReceipts || {};
      const r = await receipts.scanMailbox(api, status.seenReceipts, { now, days: settings.subscriptionLookbackDays, log });
      // Counted, not named.
      if (r.read) log(`sync ${email}: ${r.read} billing email(s) read, ${r.new} new subscription(s), ${r.renewals} renewal(s)`);
    } catch (e) {
      if (e.permanent) fail('Subscriptions', e);
      else log(`sync ${email}: subscription check skipped: ${e.message}`);
    }
  }

  return finish();

  function finish() {
    if (candidates.length) {
      const r = autotasks.mergeHomework(state, candidates, now);
      if (r.added || r.updated) log(`sync ${email}: ${r.added} new, ${r.updated} moved`);
    }
    status.lastSync = now.toISOString();
    status.lastError = errors.length ? errors.slice(0, 3).join(' | ') : null;
    status.needsReconnect = permanent;
    return { email, errors, permanent };
  }
}

let running = null;

/**
 * Sync every connected account. Concurrent calls share one run, so the timer
 * and a "Sync now" click cannot race each other over the state file.
 */
function syncAll(log = () => {}) {
  if (running) return running;
  running = (async () => {
    // Each account refreshes with the client it signed in with; any usable client at all will do here.
    if (!oauth.allClients().length) return { skipped: 'no client' };

    const accounts = loadAccounts();
    const settings = loadSettings();
    const tokens = oauth.loadTokens();
    const state = autotasks.load();
    const now = new Date();
    const results = [];

    // When the reading rules change, everything captured under the old rules
    // is re-read. Anything you have acted on - confirmed, dismissed, or marked
    // done - is kept, so an upgrade never undoes a decision.
    if (state.extractVersion !== homework.EXTRACT_VERSION) {
      const touched = new Set((store.loadHistory().records || []).map((r) => r.taskId));
      let dropped = 0;
      for (const [k, v] of Object.entries(state.homework)) {
        if (!v.confirmed && !v.dismissed && !touched.has(k)) { delete state.homework[k]; dropped++; }
      }
      for (const s of Object.values(state.sync)) {
        s.seen = {};
        s.threads = {};
      }
      state.extractVersion = homework.EXTRACT_VERSION;
      log(`reading rules updated to v${homework.EXTRACT_VERSION}: re-reading ${dropped} captured item(s)`);
    }

    for (const [email, acct] of Object.entries(accounts)) {
      if (!tokens[email]) {
        state.sync[email] = { ...(state.sync[email] || {}), needsReconnect: true, lastError: 'Not connected' };
        continue;
      }
      try {
        results.push(await syncAccount(email, acct, state, settings, now, log));
      } catch (e) {
        log(`sync ${email} failed: ${e.stack || e.message}`);
        state.sync[email] = { ...(state.sync[email] || {}), lastError: e.message, lastSync: now.toISOString() };
      }
    }

    autotasks.save(state);
    return { results };
  })().finally(() => { running = null; });
  return running;
}

function isRunning() {
  return !!running;
}

/** Cached events from every account whose calendar is switched on. */
function cachedEvents(rangeStart, rangeEnd) {
  const accounts = loadAccounts();
  const out = [];
  for (const [email, acct] of Object.entries(accounts)) {
    if (!acct.calendar) continue;
    const cache = readJson(cacheFile(email), null);
    if (!cache) continue;
    for (const ev of cache.events || []) {
      const start = new Date(ev.start);
      const end = new Date(ev.end);
      if (end < rangeStart || start > rangeEnd) continue;
      out.push({
        uid: `${email}:${ev.id}`,
        title: ev.title,
        location: ev.location,
        start,
        end,
        allDay: ev.allDay,
        // A primary calendar is named after its email address, which tells
        // you nothing on a busy day. Those read as "School" or "Personal".
        calendar: !ev.calendarName || ev.calendarName.includes('@')
          ? (acct.role === 'school' ? 'School' : 'Personal')
          : ev.calendarName,
        calendarId: ev.calendarId,
        color: ev.color,
        link: ev.htmlLink,
        account: email,
      });
    }
  }
  return out;
}

module.exports = {
  ACCOUNTS_FILE, SETTINGS_FILE, ROLE_DEFAULTS,
  loadSettings, loadAccounts, addAccount, updateAccount, removeAccount,
  syncAll, isRunning, cachedEvents,
  normalizeEvent, normalizeMessage, normalizeThread, localDate, homeworkQuery, repliesQuery,
};
