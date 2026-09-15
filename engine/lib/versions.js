'use strict';
/**
 * versions.js - saved copies of the app's code, so letting the assistant
 * reshape Mellow is never a one-way door.
 *
 * "Original" is taken by itself the first time it is needed (the engine
 * starting, or the assistant's first change to the app), so there is always a
 * preset to go back to. You can save your own versions by name ("my layout")
 * and go back to any of them later. Going back first saves how things are
 * right now, so that can be undone too.
 *
 * Only code is copied: the .js, .html, .css, .md and script files the assistant
 * is allowed to change. Your data and settings (every .json, tasks, finances,
 * health, conversations, keys) are never part of a version, so going back
 * changes how Mellow works, not what it knows. The files that decide what gets
 * blocked follow the assistant's own rule: while they are locked, going back
 * leaves them as they are.
 *
 * Stored under engine/assistant/versions: one small index per version, and
 * each file's content once, by its hash, however many versions share it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENGINE = path.join(__dirname, '..');
const APP = path.join(ENGINE, '..');
const DIR = path.join(process.env.RATCHET_DATA_DIR || ENGINE, 'assistant', 'versions');
const BLOBS = path.join(DIR, 'blobs');

const CODE_EXT = new Set(['.js', '.html', '.css', '.md', '.ps1', '.sh', '.cmd', '.command']);
const MAX_AUTO = 8;

// Loaded when used: the assistant needs this module too.
const assistant = () => require('./ai/assistant');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}
const rel = (abs) => path.relative(APP, abs).split(path.sep).join('/');
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Every code file a version covers, as { rel: abs }. */
function codeFiles() {
  const { access } = assistant();
  const out = {};
  const walk = (dirAbs, depth) => {
    if (depth > 6) return;
    let entries = [];
    try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const abs = path.join(dirAbs, e.name);
      const r = rel(abs);
      if (e.isDirectory()) {
        if (/^(dist|notify-queue|engine\/(assistant|drops|google-cache|news-cache|calendar-cache|art))$/.test(r)) continue;
        walk(abs, depth + 1);
      } else if (CODE_EXT.has(path.extname(e.name).toLowerCase()) && access(r).read) {
        out[r] = abs;
      }
    }
  };
  walk(APP, 0);
  return out;
}

function metaFile(id) { return path.join(DIR, `${String(id).replace(/[^a-z0-9-]/g, '')}.json`); }

function all() {
  let names = [];
  try { names = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')); } catch (_) {}
  return names.map((f) => readJson(path.join(DIR, f), null)).filter((v) => v && v.id && v.files)
    .sort((a, b) => (a.at < b.at ? 1 : -1));
}

function publicVersion(v, current) {
  const changed = current ? Object.keys({ ...v.files, ...current }).filter((r) => v.files[r] !== current[r]).length : null;
  return { id: v.id, name: v.name, kind: v.kind, at: v.at, note: v.note || '', files: Object.keys(v.files).length, differsBy: changed };
}

/** The hash of every code file as it is now. */
function currentHashes() {
  const files = codeFiles();
  const out = {};
  for (const [r, abs] of Object.entries(files)) {
    try { out[r] = hash(fs.readFileSync(abs)); } catch (_) {}
  }
  return out;
}

function list() {
  ensureOriginal();
  const current = currentHashes();
  return { versions: all().map((v) => publicVersion(v, current)) };
}

function save({ name, kind = 'saved', note = '' } = {}) {
  const files = codeFiles();
  const map = {};
  fs.mkdirSync(BLOBS, { recursive: true });
  for (const [r, abs] of Object.entries(files)) {
    let buf;
    try { buf = fs.readFileSync(abs); } catch (_) { continue; }
    const h = hash(buf);
    const blob = path.join(BLOBS, h);
    if (!fs.existsSync(blob)) fs.writeFileSync(blob, buf);
    map[r] = h;
  }
  const clean = String(name || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 60);
  const id = kind === 'original' ? 'original' : `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const v = { id, name: clean || (kind === 'original' ? 'Original' : 'Saved version'), kind, note: String(note).slice(0, 200), at: new Date().toISOString(), files: map };
  writeJson(metaFile(id), v);
  if (kind === 'auto') pruneAuto();
  return publicVersion(v, map);
}

/** The preset to go back to. Taken once, the first time anything asks. */
function ensureOriginal() {
  if (fs.existsSync(metaFile('original'))) return null;
  return save({ name: 'Original', kind: 'original', note: 'Mellow as it was before any changes were saved here.' });
}

function pruneAuto() {
  const autos = all().filter((v) => v.kind === 'auto');
  for (const v of autos.slice(MAX_AUTO)) { try { fs.unlinkSync(metaFile(v.id)); } catch (_) {} }
  collect();
}

/** Remove file contents no version uses any more. */
function collect() {
  const used = new Set();
  for (const v of all()) for (const h of Object.values(v.files)) used.add(h);
  let blobs = [];
  try { blobs = fs.readdirSync(BLOBS); } catch (_) {}
  for (const b of blobs) if (!used.has(b)) { try { fs.unlinkSync(path.join(BLOBS, b)); } catch (_) {} }
}

function remove(id) {
  if (id === 'original') throw new Error('Original is the preset to fall back on, so it stays.');
  const file = metaFile(id);
  if (!fs.existsSync(file)) throw new Error('That version is gone.');
  fs.unlinkSync(file);
  collect();
}

function rename(id, name) {
  const v = readJson(metaFile(id), null);
  if (!v) throw new Error('That version is gone.');
  const clean = String(name || '').replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 60);
  if (!clean) throw new Error('Give it a name.');
  v.name = clean;
  if (v.kind === 'auto') v.kind = 'saved';
  writeJson(metaFile(id), v);
  return publicVersion(v, null);
}

/**
 * Put the code back the way a version had it. Saves the present first. Files
 * made since that version are removed; files the assistant may not change are
 * left alone and listed.
 */
function restore(id, log) {
  const v = readJson(metaFile(id), null);
  if (!v) throw new Error('That version is gone.');
  const { access, checkSyntax } = assistant();
  for (const h of Object.values(v.files)) {
    if (!fs.existsSync(path.join(BLOBS, h))) throw new Error('Part of that version is missing, so nothing was changed.');
  }
  const current = currentHashes();
  const differing = Object.keys({ ...v.files, ...current }).filter((r) => v.files[r] !== current[r]);
  if (!differing.length) return { changed: [], removed: [], locked: [], restart: false, backup: null, same: true };

  const backup = save({ name: `Before going back to ${v.name}`, kind: 'auto' });
  const out = { changed: [], removed: [], locked: [], restart: false, backup: backup.id };
  for (const r of differing) {
    const a = access(r);
    if (!a.write) { out.locked.push(r); continue; }
    const abs = path.join(APP, ...r.split('/'));
    if (v.files[r]) {
      const buf = fs.readFileSync(path.join(BLOBS, v.files[r]));
      if (checkSyntax(r, buf.toString('utf8'))) { out.locked.push(r); continue; }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      out.changed.push(r);
    } else {
      try { fs.unlinkSync(abs); out.removed.push(r); } catch (_) {}
    }
    if (/\.js$/.test(r) && !/^engine\/test-/.test(r)) out.restart = true;
  }
  if (log) log(`versions: went back to ${v.id} (${out.changed.length} changed, ${out.removed.length} removed, ${out.locked.length} left alone; saved ${backup.id} first)`);
  return out;
}

module.exports = { list, save, ensureOriginal, remove, rename, restore, codeFiles, currentHashes, DIR };
