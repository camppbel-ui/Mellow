'use strict';
/**
 * api.js - the handful of Gmail and Calendar calls Mellow needs.
 *
 * Every call goes through one function that attaches the access token and,
 * if Google says it has expired, refreshes it once and tries again. Nothing
 * else in the engine has to think about tokens.
 */

const https = require('https');
const http = require('http');
const oauth = require('./oauth');

const GMAIL = process.env.RATCHET_GOOGLE_API_BASE
  ? `${process.env.RATCHET_GOOGLE_API_BASE}/gmail/v1`
  : 'https://gmail.googleapis.com/gmail/v1';
const CALENDAR = process.env.RATCHET_GOOGLE_API_BASE
  ? `${process.env.RATCHET_GOOGLE_API_BASE}/calendar/v3`
  : 'https://www.googleapis.com/calendar/v3';

function getJson(url, accessToken, timeoutMs = 25000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, {
      timeout: timeoutMs,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        data += c;
        if (data.length > 20 * 1024 * 1024) { req.destroy(); resolve({ status: 0, json: null, text: 'response too large' }); }
      });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, text: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 0, json: null, text: e.message }));
  });
}

class ApiError extends Error {
  constructor(message, status, permanent = false) {
    super(message);
    this.status = status;
    this.permanent = permanent;
  }
}

/**
 * One connected account. Holds nothing but the email address; the tokens are
 * read from disk on each refresh so two sync runs cannot disagree about them.
 */
class Account {
  constructor(email) {
    this.email = email;
  }

  async accessToken(force = false) {
    const t = oauth.loadTokens()[this.email];
    if (!t || !t.refresh_token) {
      throw new ApiError('Not connected. Reconnect this account.', 401, true);
    }
    // The client that issued this sign-in, which may not be the newest one.
    const client = oauth.clientFor(t);
    if (!client || client.error) throw new ApiError('Google client is not configured', 0, true);
    // Refresh a minute early, so a token never expires between the check
    // and the request that uses it.
    if (!force && t.access_token && t.expires_at && t.expires_at - Date.now() > 60000) {
      return t.access_token;
    }

    const r = await oauth.refresh(client, t.refresh_token);
    if (!r.ok) throw new ApiError(r.error, 401, !!r.permanent);
    // Sign-ins from before clients were remembered learn theirs the first time it works.
    oauth.setTokens(this.email, { access_token: r.access_token, expires_at: r.expires_at, ...(t.client_id ? {} : { client_id: client.clientId }) });
    return r.access_token;
  }

  async get(url) {
    let token = await this.accessToken();
    let res = await getJson(url, token);
    if (res.status === 401) {
      token = await this.accessToken(true);
      res = await getJson(url, token);
    }
    if (res.status !== 200) {
      const msg = res.json && res.json.error
        ? (res.json.error.message || JSON.stringify(res.json.error))
        : (res.text || '').slice(0, 200);
      // 403 from Gmail or Calendar almost always means the API is not enabled
      // in the Cloud project, which is a setup step, not a transient failure.
      const hint = res.status === 403 && /has not been used|is disabled|not enabled/i.test(msg)
        ? ' Turn on the Gmail API and Google Calendar API for your Google Cloud project: Accounts has a button for it.' : '';
      throw new ApiError(`Google API ${res.status}: ${msg}${hint}`, res.status, res.status === 403 && !!hint);
    }
    return res.json;
  }

  /* --------------------------------- gmail ------------------------------- */

  profile() {
    return this.get(`${GMAIL}/users/me/profile`);
  }

  /** Aliases you can send as - they all count as "you" for reply detection. */
  async sendAs() {
    try {
      const r = await this.get(`${GMAIL}/users/me/settings/sendAs`);
      return (r.sendAs || []).map((s) => String(s.sendAsEmail).toLowerCase());
    } catch (_) {
      return [];
    }
  }

  async listMessageIds(q, max = 50) {
    const u = new URL(`${GMAIL}/users/me/messages`);
    u.searchParams.set('q', q);
    u.searchParams.set('maxResults', String(Math.min(max, 100)));
    const r = await this.get(u.toString());
    return (r.messages || []).map((m) => m.id);
  }

  getMessage(id) {
    return this.get(`${GMAIL}/users/me/messages/${encodeURIComponent(id)}?format=full`);
  }

  /** Just the named headers of one message, without its body. */
  getMessageMetadata(id, headers) {
    const u = new URL(`${GMAIL}/users/me/messages/${encodeURIComponent(id)}`);
    u.searchParams.set('format', 'metadata');
    for (const h of headers || []) u.searchParams.append('metadataHeaders', h);
    return this.get(u.toString());
  }

  async listThreads(q, max = 50) {
    const u = new URL(`${GMAIL}/users/me/threads`);
    u.searchParams.set('q', q);
    u.searchParams.set('maxResults', String(Math.min(max, 100)));
    const r = await this.get(u.toString());
    return (r.threads || []).map((t) => ({ id: t.id, historyId: t.historyId }));
  }

  getThreadMetadata(id) {
    const u = new URL(`${GMAIL}/users/me/threads/${encodeURIComponent(id)}`);
    u.searchParams.set('format', 'metadata');
    for (const h of ['From', 'To', 'Cc', 'Subject', 'Date', 'List-Unsubscribe', 'List-Id', 'Precedence', 'Auto-Submitted']) {
      u.searchParams.append('metadataHeaders', h);
    }
    return this.get(u.toString());
  }

  /* -------------------------------- calendar ----------------------------- */

  async listCalendars() {
    const out = [];
    let pageToken = '';
    for (let i = 0; i < 10; i++) {
      const u = new URL(`${CALENDAR}/users/me/calendarList`);
      u.searchParams.set('maxResults', '250');
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const r = await this.get(u.toString());
      out.push(...(r.items || []));
      if (!r.nextPageToken) break;
      pageToken = r.nextPageToken;
    }
    return out;
  }

  async listEvents(calendarId, timeMin, timeMax) {
    const out = [];
    let pageToken = '';
    for (let i = 0; i < 10; i++) {
      const u = new URL(`${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events`);
      u.searchParams.set('timeMin', timeMin.toISOString());
      u.searchParams.set('timeMax', timeMax.toISOString());
      // Google expands recurring events itself, including timezones and
      // exceptions, which is more than the .ics parser attempts.
      u.searchParams.set('singleEvents', 'true');
      u.searchParams.set('orderBy', 'startTime');
      u.searchParams.set('maxResults', '250');
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const r = await this.get(u.toString());
      out.push(...(r.items || []));
      if (!r.nextPageToken) break;
      pageToken = r.nextPageToken;
    }
    return out;
  }
}

/* ---------------------------- message helpers ---------------------------- */

function header(headers, name) {
  const h = (headers || []).find((x) => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? String(h.value) : '';
}

function decodeB64Url(data) {
  try {
    return Buffer.from(String(data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch (_) {
    return '';
  }
}

function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
}

/**
 * The readable text of a message. Plain text is preferred; an HTML-only
 * message has its tags stripped. Attachments are never read.
 */
function bodyText(payload) {
  let plain = '';
  let html = '';
  const walk = (part) => {
    if (!part) return;
    if (part.filename) return;
    const type = String(part.mimeType || '').toLowerCase();
    if (part.body && part.body.data) {
      if (type === 'text/plain' && !plain) plain = decodeB64Url(part.body.data);
      else if (type === 'text/html' && !html) html = decodeB64Url(part.body.data);
    }
    for (const p of part.parts || []) walk(p);
  };
  walk(payload);
  return (plain || htmlToText(html)).slice(0, 50000);
}

function isBulk(headers) {
  return !!(header(headers, 'List-Unsubscribe') || header(headers, 'List-Id') ||
    /bulk|list|junk/i.test(header(headers, 'Precedence')));
}

function isAutomated(headers) {
  const v = header(headers, 'Auto-Submitted');
  return !!v && !/^no$/i.test(v.trim());
}

/**
 * Which account a fresh access token belongs to. Used once, straight after
 * sign-in, before there is anything saved under an email address to look up.
 */
async function profileForToken(accessToken) {
  const res = await getJson(`${GMAIL}/users/me/profile`, accessToken);
  if (res.status !== 200 || !res.json || !res.json.emailAddress) {
    const msg = res.json && res.json.error ? res.json.error.message : (res.text || '').slice(0, 200);
    const hint = res.status === 403 ? ' Enable the Gmail API in your Cloud project.' : '';
    throw new ApiError(`Google API ${res.status}: ${msg}${hint}`, res.status);
  }
  return res.json;
}

module.exports = { Account, ApiError, header, bodyText, htmlToText, decodeB64Url, isBulk, isAutomated, profileForToken };
