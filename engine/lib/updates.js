'use strict';
/**
 * updates.js - new versions of Mellow, from its GitHub releases.
 *
 * Every few hours the engine asks GitHub for the latest release. When there is
 * a newer one, the dashboard says so, with its notes, and Update installs it:
 * the release's Mellow.zip is downloaded, checked, and its code copied over
 * this copy's. Then the engine restarts itself when a start file launched it.
 *
 * What an update never touches: your data and settings. Any .json already here
 * (tasks, finances, health, engine and AI settings, the blocking config) stays
 * as it is; only files that are new come from the release. Keys, sign-ins,
 * conversations and dropped files are not in a release at all. Before anything
 * is written, how the code is now is saved under Accounts → Versions, so an
 * update - or changes you made with the assistant that it replaced - can be
 * got back.
 *
 * Only a release from the repo named in engine/version.json, downloaded over
 * https from GitHub, is used, and its SHA-256 is checked when GitHub gives one.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const zip = require('./zip');

const ENGINE = path.join(__dirname, '..');
const APP = path.join(ENGINE, '..');
const VERSION_FILE = path.join(ENGINE, 'version.json');
const STATE_FILE = path.join(process.env.RATCHET_DATA_DIR || ENGINE, 'update-state.json');
const CHECK_EVERY_MS = 6 * 3600000;
const MAX_DOWNLOAD = 60 * 1024 * 1024;
const RESTART_CODE = 75;

// Where the download may come from. GitHub redirects release files to its content hosts.
const ALLOWED_HOSTS = /^(github\.com|api\.github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com|[a-z0-9-]+\.githubusercontent\.com)$/i;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { return fallback; }
}
function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function local() {
  const v = readJson(VERSION_FILE, {});
  return {
    version: String(v.version || '0'),
    repo: /^[\w.-]+\/[\w.-]+$/.test(v.repo || '') ? v.repo : 'camppbel-ui/Mellow',
    site: /^https:\/\/[\w.-]+/.test(v.site || '') ? v.site : 'https://mellow-track.com',
  };
}

/** "2026.09.20" is newer than "2026.09.15"; "2026.09.15.2" than "2026.09.15". */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).replace(/^v/i, '').split(/[^0-9]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** One https GET, following GitHub's redirects, only to GitHub's own hosts. */
function get(url, { json = false, max = MAX_DOWNLOAD, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('bad address')); }
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.test(u.hostname)) return reject(new Error(`won't download from ${u.hostname}`));
    const req = https.get(u, {
      headers: { 'User-Agent': 'Mellow-updater', Accept: json ? 'application/vnd.github+json' : 'application/octet-stream' },
      timeout: 60000,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects'));
        return resolve(get(new URL(res.headers.location, u).toString(), { json, max, redirects: redirects - 1 }));
      }
      if (res.statusCode === 404) { res.resume(); return reject(Object.assign(new Error('No release has been published yet.'), { code: 404 })); }
      if (res.statusCode === 403 || res.statusCode === 429) { res.resume(); return reject(new Error('GitHub is limiting checks from this network. It will try again later.')); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GitHub answered ${res.statusCode}`)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > max) { req.destroy(); reject(new Error('the download is too large')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (!json) return resolve(buf);
        try { resolve(JSON.parse(buf.toString('utf8'))); } catch (_) { reject(new Error('GitHub sent something unreadable')); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

function loadState() { return readJson(STATE_FILE, {}); }

/** Ask GitHub for the latest release, at most every few hours unless forced. */
async function check({ force = false } = {}) {
  const me = local();
  const state = loadState();
  if (!force && state.checkedAt && Date.now() - new Date(state.checkedAt).getTime() < CHECK_EVERY_MS) return status();
  try {
    const rel = await get(`https://api.github.com/repos/${me.repo}/releases/latest`, { json: true, max: 2 * 1024 * 1024 });
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const asset = assets.find((a) => a.name === 'Mellow.zip') || assets.find((a) => /\.zip$/i.test(a.name));
    const next = {
      checkedAt: new Date().toISOString(), error: null,
      latest: {
        version: String(rel.tag_name || '').replace(/^v/i, ''),
        name: String(rel.name || '').slice(0, 120),
        notes: String(rel.body || '').slice(0, 4000),
        publishedAt: rel.published_at || null,
        page: /^https:\/\/github\.com\//.test(rel.html_url || '') ? rel.html_url : null,
        download: asset ? asset.browser_download_url : null,
        size: asset ? asset.size : null,
        sha256: asset && /^sha256:[0-9a-f]{64}$/i.test(asset.digest || '') ? asset.digest.slice(7).toLowerCase() : null,
      },
    };
    writeJson(STATE_FILE, next);
  } catch (e) {
    writeJson(STATE_FILE, { ...state, checkedAt: new Date().toISOString(), error: e.code === 404 ? null : e.message, noRelease: e.code === 404 });
  }
  return status();
}

function status() {
  const me = local();
  const state = loadState();
  const latest = state.latest || null;
  const available = !!(latest && latest.version && latest.download && compareVersions(latest.version, me.version) > 0);
  return {
    current: me.version, repo: me.repo, site: me.site,
    latest, available, checkedAt: state.checkedAt || null, error: state.error || null, noRelease: !!state.noRelease,
    canRestart: process.env.MELLOW_LAUNCHER === '1',
    // 'windows' or 'mac' when the downloaded app started this engine, so the dashboard can offer Quit.
    app: /^(windows|mac)$/.test(process.env.MELLOW_APP || '') ? process.env.MELLOW_APP : null,
    lastUpdate: state.lastUpdate || null,
  };
}

/* Settings and data that are already here are kept; a release only adds ones that are missing. */
function keepExisting(rel) {
  // The shared Google client comes with Mellow, like its code, so a release can replace it.
  return /\.json$/i.test(rel) && rel !== 'engine/version.json' && rel !== 'engine/google-shared-client.json';
}

// Never written by an update, whatever a zip contains.
const NEVER = [/^engine\/(assistant|drops|google-cache|news-cache|calendar-cache|art)\//, /^engine\/ai-key\.txt$/, /client_secret/i, /^engine\/google-tokens\.json$/,
  /^engine\/google-accounts\.json$/, /\.log$/, /^dist\//, /^notify-queue\//, /^\.git\//,
  // The Windows and Mac apps' own launcher and the Node.js they bring: running while an update installs, and not part of a release.
  /^runtime\//, /^Mellow\.exe$/i, /^(Microsoft\.Web\.WebView2\.[\w.]+|WebView2Loader)\.dll$/i, /^\.webview\//];
// A launcher can be running while it is replaced, so it is written beside itself and swapped in at the next start.
const LAUNCHERS = new Set(['start-ratchet.cmd', 'start-ratchet.command']);

/** Where each file in a release zip would go, and what happens to it. */
function plan(buf, expectVersion) {
  const list = zip.entries(buf);
  const files = [];
  for (const e of list) {
    if (e.name.endsWith('/')) continue;
    const m = /^Mellow\/(.+)$/.exec(e.name);
    if (!m) throw new Error(`unexpected file in the release: ${e.name}`);
    const rel = m[1];
    if (rel.includes('\\') || rel.split('/').some((s) => s === '..' || s === '.' || s === '') || /^[a-z]:/i.test(rel)) throw new Error(`unsafe path in the release: ${rel}`);
    if (NEVER.some((re) => re.test(rel))) continue;
    files.push({ rel, entry: e });
  }
  const names = new Set(files.map((f) => f.rel));
  if (!names.has('engine/engine.js') || !names.has('engine/dashboard.html') || !names.has('engine/version.json')) throw new Error('that release is missing parts of Mellow');
  const v = JSON.parse(files.find((f) => f.rel === 'engine/version.json').entry.read().toString('utf8'));
  if (expectVersion && compareVersions(v.version, expectVersion) !== 0) throw new Error(`the release says it is ${v.version}, not ${expectVersion}`);
  return { files, version: v.version };
}

/**
 * Download and install the latest release. Returns what was written and kept.
 * log gets counts only.
 */
async function apply({ log = () => {}, versions, checkSyntax } = {}) {
  const s = await check({ force: true });
  if (!s.available) throw new Error(s.error || `This is already the latest Mellow (${s.current}).`);
  const buf = await get(s.latest.download);
  if (s.latest.sha256) {
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== s.latest.sha256) throw new Error('The download didn\'t match what GitHub says it should be, so nothing was changed.');
  }
  return install(buf, { expectVersion: s.latest.version, log, versions, checkSyntax });
}

/** Install a release zip's files into appDir (this copy of Mellow unless a test says otherwise). */
function install(buf, { expectVersion = null, log = () => {}, versions = null, checkSyntax = null, appDir = APP, stateFile = STATE_FILE } = {}) {
  const p = plan(buf, expectVersion);
  const current = readJson(path.join(appDir, 'engine', 'version.json'), {}).version || '0';

  // Read and check everything before writing anything.
  const staged = [];
  for (const f of p.files) {
    const bytes = f.entry.read();
    if (checkSyntax && /\.(js|html)$/i.test(f.rel)) {
      const err = checkSyntax(f.rel, bytes.toString('utf8'));
      if (err) throw new Error(`${f.rel} in the release doesn't parse, so nothing was changed: ${err}`);
    }
    staged.push({ ...f, bytes });
  }

  let backup = null;
  if (versions) {
    try { backup = versions.save({ name: `Before updating to ${p.version}`, kind: 'auto', note: `Mellow ${current}, saved before the update.` }); } catch (e) { log(`update: could not save a version first: ${e.message}`); }
  }

  const out = { from: current, to: p.version, written: 0, kept: 0, unchanged: 0, backup: backup ? backup.id : null };
  // version.json last, so an update cut off halfway is offered again.
  staged.sort((a, b) => (a.rel === 'engine/version.json') - (b.rel === 'engine/version.json'));
  for (const f of staged) {
    const abs = path.join(appDir, ...f.rel.split('/'));
    if (!abs.startsWith(appDir + path.sep)) continue;
    const exists = fs.existsSync(abs);
    if (exists && keepExisting(f.rel)) { out.kept++; continue; }
    if (exists) {
      try { if (fs.readFileSync(abs).equals(f.bytes)) { out.unchanged++; continue; } } catch (_) {}
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const target = LAUNCHERS.has(f.rel) && exists ? `${abs}.new` : abs;
    const tmp = `${target}.updating`;
    fs.writeFileSync(tmp, f.bytes);
    if (/\.(command|sh)$/.test(f.rel) && process.platform !== 'win32') { try { fs.chmodSync(tmp, 0o755); } catch (_) {} }
    fs.renameSync(tmp, target);
    out.written++;
  }
  writeJson(stateFile, { ...readJson(stateFile, {}), lastUpdate: { at: new Date().toISOString(), from: out.from, to: out.to, written: out.written } });
  log(`update: ${out.from} -> ${out.to}, ${out.written} file(s) written, ${out.kept} setting file(s) kept, ${out.unchanged} unchanged`);
  return { ...out, restart: process.env.MELLOW_LAUNCHER === '1' };
}

module.exports = { check, status, apply, install, plan, compareVersions, local, keepExisting, RESTART_CODE, VERSION_FILE, STATE_FILE };
