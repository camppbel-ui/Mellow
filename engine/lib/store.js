'use strict';
/**
 * store.js - tasks in, history out.
 *
 * History is append-only and stored as plain readable JSON, for the same
 * reason the client's state file is: a thing that holds your machine hostage
 * should not also hold your data hostage. You can open it, read it, and delete
 * it, and nothing here will stop you.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TASKS_FILE = path.join(ROOT, 'tasks.json');
const HISTORY_FILE = path.join(ROOT, 'history.json');
const CONFIG_FILE = path.join(ROOT, 'engine-config.json');

/** PowerShell writes BOMs. JSON.parse refuses them. Strip it every time. */
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
  fs.renameSync(tmp, file); // Atomic, so a crash mid-write cannot truncate it.
}

function loadConfig() {
  const defaults = {
    port: 7777,
    bindHost: '127.0.0.1',
    passesPerWeek: 2,
    recheckInSeconds: 60,
    token: '',
  };
  return { ...defaults, ...readJson(CONFIG_FILE, {}) };
}

function loadTasks() {
  const raw = readJson(TASKS_FILE, { tasks: [] });
  return (raw.tasks || []).filter((t) => t && t.id && !String(t.id).startsWith('_'));
}

function saveTasks(tasks) {
  const existing = readJson(TASKS_FILE, {});
  writeJson(TASKS_FILE, { ...existing, tasks });
}

function loadHistory() {
  const h = readJson(HISTORY_FILE, { records: [] });
  if (!Array.isArray(h.records)) h.records = [];
  return h;
}

/**
 * Append one satisfying record. kind is 'done' or 'pass'.
 * Returns the record so the caller can echo it back to the dashboard.
 */
function append(taskId, kind, note) {
  const history = loadHistory();
  const rec = {
    taskId,
    kind,
    note: note ? String(note).slice(0, 500) : '',
    at: new Date().toISOString(),
  };
  history.records.push(rec);
  writeJson(HISTORY_FILE, history);
  return rec;
}

/**
 * Undo the most recent record for a task, but only within a few minutes.
 *
 * A misclick should be fixable. An hour later it is not a misclick, it is
 * rewriting history to get Steam back, and that is the thing this whole system
 * exists to make expensive.
 */
function undoRecent(taskId, withinMinutes = 5) {
  const history = loadHistory();
  for (let i = history.records.length - 1; i >= 0; i--) {
    const rec = history.records[i];
    if (rec.taskId !== taskId) continue;
    const ageMin = (Date.now() - new Date(rec.at).getTime()) / 60000;
    if (ageMin > withinMinutes) return null;
    history.records.splice(i, 1);
    writeJson(HISTORY_FILE, history);
    return rec;
  }
  return null;
}

module.exports = {
  ROOT, TASKS_FILE, HISTORY_FILE, CONFIG_FILE,
  readJson, writeJson,
  loadConfig, loadTasks, saveTasks, loadHistory, append, undoRecent,
};
