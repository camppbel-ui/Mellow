'use strict';
/**
 * oauth.js - Google sign-in for an installed app, with no libraries.
 *
 * The flow is the one Google recommends for desktop software: the loopback
 * redirect with PKCE. Your browser goes to Google, you approve, and Google
 * sends the browser back to http://127.0.0.1:7777/oauth/callback with a
 * one-time code, which the engine swaps for a refresh token.
 *
 * What never happens: this code never sees your Google password. It only ever
 * receives the code Google chooses to hand back after you have approved.
 *
 * Scopes are read-only on purpose. Mellow cannot send, delete, label or
 * archive a single email, and cannot change a calendar. If it ever needed to,
 * that would be a new consent you would see and have to approve.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const TOKENS_FILE = path.join(ROOT, 'google-tokens.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];

// Overridable only so the tests can stand in a fake Google.
const AUTH_URL = process.env.RATCHET_GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.RATCHET_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';

/* ------------------------------- client file ----------------------------- */

/**
 * The OAuth client you created in Google Cloud. Google's download is named
 * client_secret_<long id>.json; any file matching that, or google-client.json,
 * is picked up so you do not have to rename anything.
 */
function findClientFile() {
  try {
    const names = fs.readdirSync(ROOT);
    const named = names.find((n) => n === 'google-client.json');
    if (named) return path.join(ROOT, named);
    const downloaded = names.filter((n) => /^client_secret.*\.json$/i.test(n)).sort();
    if (downloaded.length) return path.join(ROOT, downloaded[downloaded.length - 1]);
  } catch (_) {}
  return null;
}

function loadClient() {
  const file = findClientFile();
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    // "installed" is a Desktop app client. "web" would also carry these
    // fields, but its redirect rules reject loopback, so it is refused
    // up front rather than failing mysteriously at Google's end.
    const c = raw.installed;
    if (!c || !c.client_id) {
      return { error: raw.web ? 'That client is a "Web application". Create a "Desktop app" client instead.' : 'Not a Google OAuth client file.' };
    }
    return { clientId: c.client_id, clientSecret: c.client_secret || '', file: path.basename(file) };
  } catch (e) {
    return { error: `Could not read ${path.basename(file)}: ${e.message}` };
  }
}

/* --------------------------------- tokens -------------------------------- */

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8').replace(/^﻿/, ''));
  } catch (_) {
    return {};
  }
}

function saveTokens(all) {
  const tmp = `${TOKENS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
  fs.renameSync(tmp, TOKENS_FILE);
}

function setTokens(email, t) {
  const all = loadTokens();
  all[email] = { ...(all[email] || {}), ...t };
  saveTokens(all);
}

function removeTokens(email) {
  const all = loadTokens();
  delete all[email];
  saveTokens(all);
}

/* ---------------------------------- PKCE --------------------------------- */

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makePkce() {
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// Sign-ins in progress, keyed by the random state value. In memory only: a
// half-finished sign-in has no business surviving an engine restart.
const pending = new Map();

function beginSignIn(client, redirectUri, role) {
  // Old attempts are dropped, so an abandoned consent tab cannot be finished
  // an hour later.
  for (const [k, v] of pending) {
    if (Date.now() - v.createdAt > 15 * 60000) pending.delete(k);
  }

  const state = b64url(crypto.randomBytes(24));
  const { verifier, challenge } = makePkce();
  pending.set(state, { verifier, role, redirectUri, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // offline + consent is what makes Google issue a refresh token. Without
    // them the engine would lose access an hour after you connect.
    access_type: 'offline',
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
  });

  return `${AUTH_URL}?${params.toString()}`;
}

function takePending(state) {
  const p = pending.get(state);
  if (p) pending.delete(state);
  return p || null;
}

/* ---------------------------------- HTTP --------------------------------- */

function postForm(url, fields, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const body = new URLSearchParams(fields).toString();
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(u, {
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, text: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, json: null, text: e.message }));
    req.end(body);
  });
}

/**
 * Explain a Google error in terms of what to do about it. The raw codes are
 * useless to a person, and the two that matter here are specific.
 */
function explain(json, text) {
  const code = json && (json.error || '');
  const desc = json && (json.error_description || '');
  if (code === 'invalid_grant') {
    return 'Google no longer accepts this sign-in. If your OAuth app is still in "Testing", Google expires ' +
      'its refresh tokens after 7 days - publish it (see GOOGLE-SETUP.md) and reconnect.';
  }
  if (code === 'admin_policy_enforced' || /admin/i.test(desc)) {
    return 'Your school\'s Google administrator blocks unapproved apps from reading this account.';
  }
  if (code === 'redirect_uri_mismatch') {
    return 'Google rejected the redirect address. The client must be a "Desktop app" type.';
  }
  return `${code || 'error'}${desc ? `: ${desc}` : ''}${!code && text ? `: ${String(text).slice(0, 200)}` : ''}`;
}

async function exchangeCode(client, code, verifier, redirectUri) {
  const res = await postForm(TOKEN_URL, {
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  if (res.status !== 200 || !res.json || !res.json.access_token) {
    return { ok: false, error: explain(res.json, res.text) };
  }
  return {
    ok: true,
    tokens: {
      access_token: res.json.access_token,
      refresh_token: res.json.refresh_token || null,
      expires_at: Date.now() + (res.json.expires_in || 3600) * 1000,
      scope: res.json.scope || '',
    },
  };
}

async function refresh(client, refreshToken) {
  const res = await postForm(TOKEN_URL, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (res.status !== 200 || !res.json || !res.json.access_token) {
    return { ok: false, error: explain(res.json, res.text), permanent: res.json && res.json.error === 'invalid_grant' };
  }
  return {
    ok: true,
    access_token: res.json.access_token,
    expires_at: Date.now() + (res.json.expires_in || 3600) * 1000,
  };
}

module.exports = {
  SCOPES, TOKENS_FILE,
  findClientFile, loadClient,
  loadTokens, setTokens, removeTokens,
  makePkce, beginSignIn, takePending,
  exchangeCode, refresh, explain,
};
