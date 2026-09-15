'use strict';
/**
 * claude.js - the one place Mellow talks to Claude.
 *
 * Raw HTTPS to the Messages API rather than the Anthropic SDK, for the same
 * reason as everything else here: Mellow is a folder you copy and run with
 * Node, with no npm install, and that is what makes it something you can hand
 * to a friend.
 *
 * Three guards live here so no caller can forget them:
 *   - the key is read from engine/ai-key.txt (or ANTHROPIC_API_KEY) and never
 *     sent anywhere but api.anthropic.com;
 *   - every request is priced as it comes back, and nothing is sent once the
 *     month's limit in ai.json is spent;
 *   - a declined request comes back as { refusal: true }, never as content.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..', '..');
const SETTINGS_FILE = path.join(ROOT, 'ai.json');
const KEY_FILE = path.join(ROOT, 'ai-key.txt');
const USAGE_FILE = path.join(ROOT, 'ai-usage.json');

const DEFAULTS = {
  enabled: true,
  model: 'claude-opus-5',
  assistantEffort: 'high',
  scanEffort: 'medium',
  monthlyLimitUsd: 20,
  webAccess: true,
  assistantCanEditEnforcement: false,
};

// Web search is billed per search on top of tokens: $10 per 1,000.
const WEB_SEARCH_USD = 0.01;

/**
 * Anthropic's own web search and web fetch, run on their servers: the PC makes
 * no extra connections. The newer versions filter results before they reach
 * the model; Haiku 4.5 only has the basic ones.
 */
function webTools(model) {
  const basic = model === 'claude-haiku-4-5';
  return [
    { type: basic ? 'web_search_20250305' : 'web_search_20260209', name: 'web_search', max_uses: 8 },
    { type: basic ? 'web_fetch_20250910' : 'web_fetch_20260209', name: 'web_fetch', max_uses: 8, max_content_tokens: 40000 },
  ];
}

// Per million tokens. Cache writes cost 1.25x input, cache reads 0.1x.
const PRICES = {
  'claude-fable-5-1': [10, 50],
  'claude-fable-5': [10, 50],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-4-5': [1, 5],
};

// Models that accept server-side refusal fallbacks in "default" mode.
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { return fallback; }
}

function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function loadSettings() {
  const raw = readJson(SETTINGS_FILE, {});
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (raw[k] !== undefined) out[k] = raw[k];
  if (!/^claude-[a-z0-9-]+$/.test(String(out.model))) out.model = DEFAULTS.model;
  out.monthlyLimitUsd = Math.max(0, Number(out.monthlyLimitUsd) || 0);
  return out;
}

/** Only the fields the dashboard may change; the edit-enforcement switch is not one of them. */
function saveSettings(patch) {
  const raw = readJson(SETTINGS_FILE, {});
  const next = { _comment: raw._comment || 'Mellow AI settings. assistantCanEditEnforcement can only be changed here, by hand.', ...raw };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (typeof patch.webAccess === 'boolean') next.webAccess = patch.webAccess;
  if (patch.monthlyLimitUsd !== undefined && Number.isFinite(Number(patch.monthlyLimitUsd))) {
    next.monthlyLimitUsd = Math.max(0, Math.min(1000, Number(patch.monthlyLimitUsd)));
  }
  if (typeof patch.model === 'string' && PRICES[patch.model]) next.model = patch.model;
  for (const k of ['assistantEffort', 'scanEffort']) {
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(patch[k])) next[k] = patch[k];
  }
  writeJson(SETTINGS_FILE, next);
  return loadSettings();
}

function loadKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch (_) { return ''; }
}

function saveKey(key) {
  const k = String(key || '').trim();
  if (!k) { try { fs.unlinkSync(KEY_FILE); } catch (_) {} return; }
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) throw new Error('That does not look like an Anthropic API key. They start with sk-ant-.');
  fs.writeFileSync(KEY_FILE, k);
}

/* ---------------------------------- spend -------------------------------- */

function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function loadUsage() {
  const u = readJson(USAGE_FILE, {});
  if (u.month !== monthKey()) return { month: monthKey(), usd: 0, calls: 0, inputTokens: 0, outputTokens: 0, recent: [] };
  return { recent: [], ...u };
}

function priceOf(model, usage) {
  const [inP, outP] = PRICES[model] || PRICES['claude-opus-5'];
  const u = usage || {};
  return ((u.input_tokens || 0) * inP + (u.cache_creation_input_tokens || 0) * inP * 1.25 +
    (u.cache_read_input_tokens || 0) * inP * 0.1 + (u.output_tokens || 0) * outP) / 1e6 +
    ((u.server_tool_use && u.server_tool_use.web_search_requests) || 0) * WEB_SEARCH_USD;
}

function recordUsage(model, usage, purpose) {
  const u = loadUsage();
  const usd = priceOf(model, usage);
  u.usd = Math.round((u.usd + usd) * 10000) / 10000;
  u.calls += 1;
  u.inputTokens += (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  u.outputTokens += usage.output_tokens || 0;
  u.recent = [{ at: new Date().toISOString(), purpose, model, usd: Math.round(usd * 10000) / 10000 }, ...(u.recent || [])].slice(0, 40);
  try { writeJson(USAGE_FILE, u); } catch (_) {}
  return usd;
}

function status() {
  const s = loadSettings();
  const u = loadUsage();
  return {
    enabled: s.enabled,
    hasKey: !!loadKey(),
    keyFromEnv: !!process.env.ANTHROPIC_API_KEY,
    model: s.model,
    models: Object.keys(PRICES),
    assistantEffort: s.assistantEffort,
    scanEffort: s.scanEffort,
    monthlyLimitUsd: s.monthlyLimitUsd,
    webAccess: !!s.webAccess,
    spentUsd: Math.round(u.usd * 100) / 100,
    calls: u.calls,
    canEditEnforcement: !!s.assistantCanEditEnforcement,
  };
}

class AiError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/** Why AI cannot run right now, or null. */
function unavailable() {
  const s = loadSettings();
  if (!s.enabled) return 'AI is switched off in Accounts → AI.';
  if (!loadKey()) return 'Add an Anthropic API key in Accounts → AI first.';
  const u = loadUsage();
  if (s.monthlyLimitUsd > 0 && u.usd >= s.monthlyLimitUsd) {
    return `This month's AI limit of $${s.monthlyLimitUsd} is used up. Raise it in Accounts → AI.`;
  }
  return null;
}

/* --------------------------------- request ------------------------------- */

function post(body, key, headers) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = https.request({
      host: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      timeout: 10 * 60000,
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, json, text, retryAfter: Number(res.headers['retry-after']) || 0 });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timed out' }); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.end(payload);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One Messages API request. `purpose` labels the spend. Returns the response
 * with `refusal` set when Claude declined, and `usd` for what it cost.
 */
async function messages(body, { purpose = 'ai' } = {}) {
  const why = unavailable();
  if (why) throw new AiError(why, 'unavailable');
  const s = loadSettings();
  const key = loadKey();
  const model = body.model || s.model;
  const request = { ...body, model };
  const headers = {};
  if (FALLBACK_MODELS.has(model)) {
    // If Claude declines, the API re-runs the request on its recommended
    // fallback model instead of returning the refusal.
    request.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await post(request, key, headers);
    const retry = res.status === 0 || res.status === 429 || res.status === 529 || res.status >= 500;
    if (!retry || attempt === 3) break;
    await sleep(res.retryAfter ? res.retryAfter * 1000 : 1500 * 2 ** attempt);
  }

  if (res.status !== 200 || !res.json) {
    const msg = res.json && res.json.error ? res.json.error.message : res.error || `HTTP ${res.status}`;
    if (res.status === 401) throw new AiError('The API key was rejected. Check it in Accounts → AI.', 'auth');
    if (res.status === 400 && /credit balance/i.test(msg)) throw new AiError('Your Anthropic account is out of credit.', 'billing');
    throw new AiError(`Claude could not be reached: ${msg}`, 'api');
  }

  const out = res.json;
  out.usd = recordUsage(out.model || model, out.usage || {}, purpose);
  out.refusal = out.stop_reason === 'refusal';
  return out;
}

function textOf(response) {
  return (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

module.exports = {
  loadSettings, saveSettings, loadKey, saveKey, status, unavailable, messages, textOf, priceOf, webTools,
  AiError, PRICES, SETTINGS_FILE, KEY_FILE, USAGE_FILE,
};
