'use strict';
/**
 * stocks.js - prices for the handful of stocks you follow.
 *
 * From Yahoo Finance's public chart endpoint: no key, no account, fifteen
 * minutes delayed at worst. It is an unofficial endpoint, so it can change
 * without notice. When it fails, the last prices are kept and marked stale,
 * the same way the news and calendars behave.
 *
 * This shows prices. It does not advise, predict or trade.
 */

const fs = require('fs');
const path = require('path');

const { fetchText } = require('./calendar');

const ROOT = path.join(__dirname, '..');
const SETTINGS_FILE = path.join(ROOT, 'stocks.json');
const CACHE_FILE = path.join(ROOT, 'stocks-cache.json');

function loadSettings() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^﻿/, '')); } catch (_) {}
  const symbols = (Array.isArray(raw.symbols) ? raw.symbols : ['AEVA', 'LULU', 'AZN', 'NKE'])
    .map((s) => String(s).trim().toUpperCase())
    // Tickers only. This goes into a URL, so nothing else gets through.
    .filter((s) => /^[A-Z0-9.^=-]{1,12}$/.test(s))
    .slice(0, 20);
  const colors = {};
  for (const [k, v] of Object.entries(raw.colors || {})) if (/^#[0-9a-f]{6}$/i.test(v)) colors[String(k).toUpperCase()] = v;
  // A company's website, for its logo. Only a bare hostname gets through.
  const domains = {};
  for (const [k, v] of Object.entries(raw.domains || {})) {
    const host = String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) domains[String(k).toUpperCase()] = host;
  }
  return { symbols, refreshMinutes: Math.max(1, Number(raw.refreshMinutes) || 5), names: raw.names || {}, colors, domains };
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { return { quotes: {} }; }
}

function writeCache(obj) {
  try {
    fs.writeFileSync(`${CACHE_FILE}.tmp`, JSON.stringify(obj, null, 2));
    fs.renameSync(`${CACHE_FILE}.tmp`, CACHE_FILE);
  } catch (_) {}
}

/** Where the market is right now for this listing: before the open, open, or closed. */
function session(meta, now) {
  const p = (meta.currentTradingPeriod || {});
  const t = Math.floor(now.getTime() / 1000);
  if (p.regular && t >= p.regular.start && t < p.regular.end) return 'open';
  if (p.pre && t >= p.pre.start && t < p.pre.end) return 'pre';
  if (p.post && t >= p.post.start && t < p.post.end) return 'after';
  return 'closed';
}

/** One chart response into the few numbers worth showing. */
function parseChart(body, now = new Date()) {
  const json = JSON.parse(body);
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !result.meta) throw new Error((json.chart && json.chart.error && json.chart.error.description) || 'no data');
  const m = result.meta;
  const price = Number(m.regularMarketPrice);
  const prev = Number(m.chartPreviousClose || m.previousClose);
  if (!Number.isFinite(price)) throw new Error('no price');
  const closes = (((result.indicators || {}).quote || [])[0] || {}).close || [];
  const points = closes.filter((x) => x != null && Number.isFinite(x));
  // Every third point is plenty for a line an inch wide.
  const spark = points.filter((_, i) => i % 3 === 0 || i === points.length - 1).map((x) => Math.round(x * 100) / 100);
  return {
    symbol: m.symbol,
    name: m.shortName || m.longName || m.symbol,
    currency: m.currency || 'USD',
    price,
    previousClose: Number.isFinite(prev) ? prev : null,
    change: Number.isFinite(prev) ? price - prev : null,
    changePercent: Number.isFinite(prev) && prev ? ((price - prev) / prev) * 100 : null,
    dayHigh: m.regularMarketDayHigh ?? null,
    dayLow: m.regularMarketDayLow ?? null,
    asOf: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
    session: session(m, now),
    spark,
  };
}

/* One refresh per distinct list at a time. The News page and the Finance page
   ask for different symbols, and neither should be handed the other's answer. */
const inFlight = new Map();

function validSymbols(list) {
  return [...new Set((list || []).map((s) => String(s).trim().toUpperCase()).filter((s) => /^[A-Z0-9.^=-]{1,12}$/.test(s)))];
}

async function refresh(symbols) {
  const key = symbols.join(',');
  if (inFlight.has(key)) return inFlight.get(key);
  const p = (async () => {
    const fresh = {};
    const errors = [];
    for (const s of symbols) {
      const r = await fetchText(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1d&interval=5m&includePrePost=false`, 12000);
      try {
        if (!r.ok) throw new Error(r.error);
        fresh[s] = { ...parseChart(r.body), fetchedAt: new Date().toISOString() };
      } catch (e) {
        errors.push(`${s}: ${e.message}`);
      }
    }
    // Read again just before writing, so a refresh of another list that
    // finished in the meantime is merged rather than overwritten.
    const cache = readCache();
    const out = {
      ...cache,
      quotes: { ...(cache.quotes || {}), ...fresh },
      triedAt: new Date().toISOString(),
      error: errors.length ? errors.join('; ') : null,
    };
    writeCache(out);
    return out;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

function quoteAge(q) {
  const at = q && (q.fetchedAt || null);
  return at ? (Date.now() - new Date(at).getTime()) / 60000 : Infinity;
}

/**
 * Quotes for any list of symbols, as a map. Missing ones are fetched before
 * answering; stale ones are refreshed behind the answer.
 */
const lastMissTried = new Map();

async function getQuotes(list, maxAgeMinutes = 5) {
  const symbols = validSymbols(list).slice(0, 40);
  let cache = readCache();
  // A symbol with no price yet is fetched before answering - but a typo that
  // Yahoo does not know is only retried every ten minutes, not on every request.
  const missing = symbols.filter((s) => !(cache.quotes || {})[s] && Date.now() - (lastMissTried.get(s) || 0) > 10 * 60000);
  if (missing.length) {
    missing.forEach((s) => lastMissTried.set(s, Date.now()));
    cache = await refresh(missing);
  }
  const stale = symbols.filter((s) => (cache.quotes || {})[s] && quoteAge(cache.quotes[s]) >= maxAgeMinutes);
  if (stale.length) refresh(stale).catch(() => {});
  const out = {};
  for (const s of symbols) if ((cache.quotes || {})[s]) out[s] = cache.quotes[s];
  return { quotes: out, triedAt: cache.triedAt || null };
}

async function getStocks() {
  const settings = loadSettings();
  let cache = readCache();
  const oldest = Math.max(...settings.symbols.map((s) => quoteAge((cache.quotes || {})[s])), 0);
  const missing = settings.symbols.some((s) => !(cache.quotes || {})[s]);
  const age = cache.triedAt ? (Date.now() - new Date(cache.triedAt).getTime()) / 60000 : Infinity;
  if (age === Infinity || (missing && age > 1)) cache = await refresh(settings.symbols);
  else if (oldest >= settings.refreshMinutes) refresh(settings.symbols).catch(() => {});

  return {
    symbols: settings.symbols,
    quotes: settings.symbols.map((s) => {
      const q = (cache.quotes || {})[s];
      if (!q) return { symbol: s, name: settings.names[s] || s, color: settings.colors[s] || null, domain: settings.domains[s] || null, missing: true };
      return { ...q, name: settings.names[s] || q.name, color: settings.colors[s] || null, domain: settings.domains[s] || null };
    }),
    error: cache.error || null,
    triedAt: cache.triedAt || null,
  };
}

/* Daily closes over a longer range, for the Finance charts. Kept in memory for
   an hour, since a daily line barely moves inside one. */
const HISTORY_RANGES = { '5d': '30m', '1mo': '1d', '3mo': '1d', '6mo': '1d', '1y': '1d', ytd: '1d' };
const historyCache = new Map();

async function getHistory(list, range) {
  if (!HISTORY_RANGES[range]) range = '1mo';
  const symbols = validSymbols(String(list).split(',')).slice(0, 40);
  const out = {};
  await Promise.all(symbols.map(async (s) => {
    const key = `${s}|${range}`;
    const hit = historyCache.get(key);
    if (hit && Date.now() - hit.at < 60 * 60000) { out[s] = hit.data; return; }
    const r = await fetchText(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=${range}&interval=${HISTORY_RANGES[range]}&includePrePost=false`, 12000);
    try {
      if (!r.ok) throw new Error(r.error);
      const result = JSON.parse(r.body).chart.result[0];
      const closes = ((result.indicators.quote || [])[0] || {}).close || [];
      const points = [];
      (result.timestamp || []).forEach((t, i) => {
        if (closes[i] != null && Number.isFinite(closes[i])) points.push([t * 1000, Math.round(closes[i] * 10000) / 10000]);
      });
      const data = { points };
      historyCache.set(key, { at: Date.now(), data });
      out[s] = data;
    } catch (e) {
      if (hit) out[s] = hit.data;
    }
  }));
  return { range, history: out };
}

module.exports = { loadSettings, parseChart, getStocks, getQuotes, getHistory, validSymbols, SETTINGS_FILE };
