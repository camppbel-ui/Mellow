'use strict';
/**
 * util.js - logging + safe command execution.
 * No dependencies. Node built-ins only.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

let LOG_PATH = null;

function initLog(p) {
  LOG_PATH = p;
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function log(level, msg) {
  const line = `[${stamp()}] ${level.padEnd(5)} ${msg}`;
  console.log(line);
  if (LOG_PATH) {
    try {
      fs.appendFileSync(LOG_PATH, line + '\n');
    } catch (_) {
      // Logging must never crash the client.
    }
  }
}

const info = (m) => log('INFO', m);
const warn = (m) => log('WARN', m);
const err = (m) => log('ERROR', m);
const dry = (m) => log('DRY', m);

/**
 * Run a command. Resolves { ok, stdout, stderr } - never rejects.
 * A failed enforcement command should degrade, not crash the loop.
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 20000, ...opts },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error ? (error.code ?? 1) : 0,
          stdout: (stdout || '').toString(),
          stderr: (stderr || '').toString(),
        });
      });
  });
}

function isWindows() {
  return process.platform === 'win32';
}

/** Read JSON, returning fallback on any failure. */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    err(`Could not write ${file}: ${e.message}`);
    return false;
  }
}

module.exports = { initLog, info, warn, err, dry, run, isWindows, readJson, writeJson };
