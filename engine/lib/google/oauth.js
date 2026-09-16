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

/*
 * Where sign-ins come from. Two kinds of client, both "Desktop app" clients
 * from Google Cloud:
 *
 *   - Your own: Google's download, client_secret_<long id>.json (or
 *     google-client.json), put in the engine folder or chosen on the Accounts
 *     page. Any number can sit there; the newest is used for new sign-ins.
 *   - A shared one: google-shared-client.json, when whoever publishes Mellow
 *     ships one with it, so a friend can connect without making their own.
 *     Yours always wins when both are there.
 *
 * A refresh token only works with the client that issued it, so each account
 * remembers its client's id and keeps using that client, whichever is newest.
 */
const SHARED_FILE = path.join(ROOT, 'google-shared-client.json');
const OWN_RE = /^(client_secret.*|google-client)\.json$/i;

function ownClientFiles() {
  let names = [];
  try { names = fs.readdirSync(ROOT).filter((n) => OWN_RE.test(n)); } catch (_) {}
  const mtime = (n) => { try { return fs.statSync(path.join(ROOT, n)).mtimeMs; } catch (_) { return 0; } };
  // google-client.json is one you named on purpose; otherwise the newest download.
  return names.sort((a, b) => (b === 'google-client.json') - (a === 'google-client.json') || mtime(b) - mtime(a) || (a < b ? 1 : -1))
    .map((n) => path.join(ROOT, n));
}

function findClientFile() {
  const own = ownClientFiles();
  if (own.length) return own[0];
  return fs.existsSync(SHARED_FILE) ? SHARED_FILE : null;
}

function readClientFile(file) {
  const shared = file === SHARED_FILE;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    // "installed" is a Desktop app client. "web" would also carry these
    // fields, but its redirect rules reject loopback, so it is refused
    // up front rather than failing mysteriously at Google's end.
    const c = raw.installed;
    if (!c || !c.client_id) {
      return { error: raw.web ? 'That client is a "Web application". Create a "Desktop app" client instead.' : 'Not a Google OAuth client file.', file: path.basename(file), shared };
    }
    return { clientId: c.client_id, clientSecret: c.client_secret || '', file: path.basename(file), shared };
  } catch (e) {
    return { error: `Could not read ${path.basename(file)}: ${e.message}`, file: path.basename(file), shared };
  }
}

/** The client new sign-ins use: your newest own client, or the shared one. */
function loadClient() {
  const file = findClientFile();
  return file ? readClientFile(file) : null;
}

/** Every usable client: yours, newest first, then the shared one. */
function allClients() {
  const files = ownClientFiles();
  if (fs.existsSync(SHARED_FILE)) files.push(SHARED_FILE);
  return files.map(readClientFile).filter((c) => !c.error);
}

/** The client an account signed in with, when it is still here; otherwise the one new sign-ins use. */
function clientFor(tokens) {
  const id = tokens && tokens.client_id;
  if (id) {
    const hit = allClients().find((c) => c.clientId === id);
    if (hit) return hit;
  }
  return loadClient();
}

function clientById(id) {
  return id ? allClients().find((c) => c.clientId === id) || null : null;
}

/** "123456789012-abc.apps.googleusercontent.com" belongs to Cloud project number 123456789012. */
function projectNumber(clientId) {
  const m = /^(\d{6,})-/.exec(String(clientId || ''));
  return m ? m[1] : null;
}

/**
 * Saves a client file chosen on the Accounts page. Only the fields a Desktop
 * client has are kept, under Google's own file name, so it is found the same
 * way a file moved into the folder by hand is. Other clients stay: accounts
 * they signed in keep working, and this one is used from now on.
 */
function saveClientFile(input) {
  let raw = input;
  if (typeof input === 'string') {
    try { raw = JSON.parse(input.replace(/^﻿/, '')); } catch (_) {
      throw new Error('That isn\'t the file Google gave you. It\'s a .json file with a name like client_secret_….json.');
    }
  }
  if (raw && raw.web && !raw.installed) {
    throw new Error('That client is a "Web application", which can\'t send the sign-in back to this computer. In Google Cloud, create another client with the type "Desktop app", and choose that file.');
  }
  const c = raw && raw.installed;
  if (!c || typeof c.client_id !== 'string' || !/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(c.client_id) || typeof c.client_secret !== 'string' || !c.client_secret) {
    throw new Error('That isn\'t a Google sign-in client. In Google Cloud, open Clients, click your Desktop client, and use Download JSON.');
  }
  const keep = {};
  for (const k of ['client_id', 'project_id', 'auth_uri', 'token_uri', 'auth_provider_x509_cert_url', 'client_secret']) {
    if (typeof c[k] === 'string') keep[k] = c[k].slice(0, 300);
  }
  if (Array.isArray(c.redirect_uris)) keep.redirect_uris = c.redirect_uris.filter((u) => typeof u === 'string').slice(0, 5);
  const before = loadClient();
  const name = `client_secret_${c.client_id}.json`;
  const file = path.join(ROOT, name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ installed: keep }, null, 2));
  fs.renameSync(tmp, file);
  // A google-client.json you named would otherwise still win. It steps aside, kept, for the accounts it signed in.
  const named = path.join(ROOT, 'google-client.json');
  if (fs.existsSync(named) && readClientFile(named).clientId !== c.client_id) {
    fs.renameSync(named, path.join(ROOT, `client_secret_previous-${Date.now()}.json`));
  }
  const now = new Date();
  try { fs.utimesSync(file, now, now); } catch (_) {}
  return {
    file: name, clientId: c.client_id, projectNumber: projectNumber(c.client_id),
    changed: !before || before.error || before.clientId !== c.client_id,
  };
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
  // The code Google sends back can only be swapped by the client that asked for it.
  pending.set(state, { verifier, role, redirectUri, clientId: client.clientId, createdAt: Date.now() });

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
    return 'Google no longer accepts this sign-in. If your app in Google Cloud is still in "Testing", Google expires ' +
      'its sign-ins after 7 days: open Audience there, click Publish app, then reconnect (GOOGLE-SETUP.md has the details).';
  }
  if (code === 'admin_policy_enforced' || /admin/i.test(desc)) {
    return 'Your school\'s Google administrator blocks unapproved apps from reading this account.';
  }
  if (code === 'redirect_uri_mismatch') {
    return 'Google rejected the redirect address. The client must be a "Desktop app" type.';
  }
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    return 'Google doesn\'t recognise the sign-in client this account used. It may have been deleted in Google Cloud. Reconnect the account.';
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
      client_id: client.clientId,
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
    return { ok: false, error: explain(res.json, res.text), permanent: !!res.json && ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(res.json.error) };
  }
  return {
    ok: true,
    access_token: res.json.access_token,
    expires_at: Date.now() + (res.json.expires_in || 3600) * 1000,
  };
}

module.exports = {
  SCOPES, TOKENS_FILE, SHARED_FILE,
  findClientFile, loadClient, allClients, clientFor, clientById, projectNumber, saveClientFile,
  loadTokens, setTokens, removeTokens,
  makePkce, beginSignIn, takePending,
  exchangeCode, refresh, explain,
};
