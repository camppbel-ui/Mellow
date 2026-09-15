'use strict';
/**
 * calendar.js - subscribes to .ics feeds and merges them into one schedule.
 *
 * Feeds are cached on disk. Two reasons: the dashboard refreshes every twenty
 * seconds and should not re-download a university timetable each time, and a
 * calendar you cannot reach should show yesterday's schedule rather than an
 * empty week. Same fail-closed instinct as the enforcement client.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const ics = require('./ics');

const ROOT = path.join(__dirname, '..');
const FEEDS_FILE = path.join(ROOT, 'calendars.json');
const CACHE_DIR = path.join(ROOT, 'calendar-cache');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (_) {
    return fallback;
  }
}

function loadFeeds() {
  const raw = readJson(FEEDS_FILE, { calendars: [] });
  return (raw.calendars || []).filter(
    (c) => c && c.url && !c.disabled && !String(c.id || '').startsWith('_')
  );
}

/** A filename that cannot escape the cache directory whatever the id is. */
function cacheFileFor(id) {
  const safe = String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return path.join(CACHE_DIR, `${safe}.ics`);
}

/**
 * Fetch a URL as text, following redirects. Google hands out a redirect for
 * its secret .ics addresses, so not following them means every Google calendar
 * silently returns nothing.
 */
function fetchText(url, timeoutMs = 20000, redirectsLeft = 5) {
  return new Promise((resolve) => {
    let mod;
    try {
      mod = new URL(url).protocol === 'http:' ? http : https;
    } catch (e) {
      return resolve({ ok: false, error: `bad URL: ${e.message}` });
    }

    const req = mod.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'Mellow/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return resolve({ ok: false, error: 'too many redirects' });
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchText(next, timeoutMs, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ ok: false, error: `HTTP ${res.statusCode}` });
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        // A runaway feed must not exhaust memory on a machine that is
        // supposed to stay up for months.
        if (body.length > 8 * 1024 * 1024) { req.destroy(); resolve({ ok: false, error: 'feed too large' }); }
      });
      res.on('end', () => resolve({ ok: true, body }));
    });

    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

/**
 * Refresh every feed whose cache is older than its refreshMinutes.
 * Returns one status line per feed, which the dashboard shows.
 */
async function refreshFeeds(options = {}) {
  const feeds = loadFeeds();
  const results = [];

  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}

  for (const feed of feeds) {
    const file = cacheFileFor(feed.id);
    let ageMin = Infinity;
    try {
      ageMin = (Date.now() - fs.statSync(file).mtimeMs) / 60000;
    } catch (_) {}

    const every = Number(feed.refreshMinutes) || 60;
    if (!options.force && ageMin < every) {
      results.push({ id: feed.id, name: feed.name, status: 'cached', ageMinutes: Math.round(ageMin) });
      continue;
    }

    const res = await fetchText(feed.url);
    if (res.ok && /BEGIN:VCALENDAR/i.test(res.body)) {
      try {
        fs.writeFileSync(file, res.body);
        results.push({ id: feed.id, name: feed.name, status: 'refreshed', ageMinutes: 0 });
      } catch (e) {
        results.push({ id: feed.id, name: feed.name, status: 'error', error: `cannot cache: ${e.message}` });
      }
    } else {
      // Keep whatever is cached. A feed that fails at 3am should not empty
      // tomorrow's schedule.
      const err = res.ok ? 'not an iCalendar feed' : res.error;
      results.push({
        id: feed.id,
        name: feed.name,
        status: fs.existsSync(file) ? 'stale' : 'error',
        error: err,
        ageMinutes: Number.isFinite(ageMin) ? Math.round(ageMin) : null,
      });
    }
  }

  return results;
}

/** Every event from every cached feed, inside the window, merged and sorted. */
function eventsBetween(rangeStart, rangeEnd) {
  const feeds = loadFeeds();
  const all = [];

  for (const feed of feeds) {
    let text;
    try {
      text = fs.readFileSync(cacheFileFor(feed.id), 'utf8');
    } catch (_) {
      continue;
    }
    try {
      all.push(...ics.parseIcs(text, rangeStart, rangeEnd, {
        id: feed.id, name: feed.name || feed.id, color: feed.color || null,
      }));
    } catch (_) {
      // One malformed feed must not take the whole calendar down.
    }
  }

  return all.sort((a, b) => a.start - b.start);
}

/** Group events into days, so the dashboard does not have to. */
function agenda(rangeStart, rangeEnd) {
  const events = eventsBetween(rangeStart, rangeEnd);
  const byDay = new Map();

  for (const e of events) {
    const d = e.start;
    const pad = (n) => String(n).padStart(2, '0');
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push({
      uid: e.uid,
      title: e.title,
      location: e.location,
      start: e.start.toISOString(),
      end: e.end.toISOString(),
      allDay: e.allDay,
      calendar: e.calendar,
      calendarId: e.calendarId,
      color: e.color,
    });
  }

  return [...byDay.entries()].map(([day, items]) => ({ day, events: items }));
}

module.exports = {
  FEEDS_FILE, CACHE_DIR,
  loadFeeds, refreshFeeds, eventsBetween, agenda, fetchText, cacheFileFor,
};
