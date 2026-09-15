'use strict';
/**
 * ratchet-client.js
 *
 * The Windows half of Mellow. A thin client over GET /api/enforcement,
 * exactly as specified in the build plan. It holds no opinion about
 * cadences, deadlines or passes - the engine decides, this obeys.
 *
 *   node ratchet-client.js                 run forever (normal use)
 *   node ratchet-client.js --once          one cycle, then exit
 *   node ratchet-client.js --clear         remove every block and exit
 *   node ratchet-client.js --status        show what is currently applied
 *   node ratchet-client.js --notify-agent  draw queued toasts in your session
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const util = require('./lib/util');
const { info, warn, err, dry } = util;
const enforce = require('./lib/enforce');
const { notify, summarise, drainQueue } = require('./lib/notify');

const CONFIG_PATH = path.join(__dirname, 'config.json');

/* --------------------------------- config -------------------------------- */

function loadConfig() {
  let cfg;
  try {
    // Strip a UTF-8 BOM. PowerShell's Set-Content writes one by default, so
    // any edit made from a script leaves a file JSON.parse will not touch.
    const text = fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '');
    cfg = JSON.parse(text);
  } catch (e) {
    console.error(`Could not read config.json: ${e.message}`);
    process.exit(1);
  }

  // Resolve relative paths against this folder so the service works from anywhere.
  cfg.paths = cfg.paths || {};
  cfg.paths.notifyQueue = cfg.paths.notifyQueue || 'notify-queue';
  for (const key of ['logFile', 'stateFile', 'notifyQueue']) {
    if (cfg.paths[key] && !path.isAbsolute(cfg.paths[key])) {
      cfg.paths[key] = path.join(__dirname, cfg.paths[key]);
    }
  }
  // notify() only ever receives the notifications section, so hand it the
  // resolved queue path rather than making it guess.
  cfg.notifications = cfg.notifications || {};
  cfg.notifications.notifyQueue = cfg.paths.notifyQueue;

  util.initLog(cfg.paths.logFile);
  return cfg;
}

/* --------------------------------- fetch --------------------------------- */

function fetchEnforcement(cfg) {
  return new Promise((resolve) => {
    const url = cfg.server.url;
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { timeout: cfg.server.timeoutMs || 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return resolve({ ok: false, error: `HTTP ${res.statusCode}` });
        }
        try {
          resolve({ ok: true, payload: JSON.parse(body) });
        } catch (e) {
          resolve({ ok: false, error: `Bad JSON: ${e.message}` });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

/* --------------------------------- state --------------------------------- */

const runtime = {
  lastGoodPayload: null,
  lastGoodAt: null,
  lastAppliedLevel: null,
  lastNotifyAt: 0,
  nudgeSent: false,
};

function minutesSince(ts) {
  if (!ts) return Infinity;
  return (Date.now() - ts) / 60000;
}

/**
 * Decide what payload to act on given a fetch result.
 * This is where fail-closed lives.
 */
function decidePayload(result, cfg) {
  if (result.ok) {
    runtime.lastGoodPayload = result.payload;
    runtime.lastGoodAt = Date.now();
    return { payload: result.payload, stale: false };
  }

  warn(`Server unreachable (${result.error}).`);

  if (!cfg.safety?.failClosed) {
    info('failClosed is off - clearing shield.');
    return { payload: { level: 'clear', blocking: false, shieldGroups: [], reasons: [] }, stale: true };
  }

  if (runtime.lastGoodPayload) {
    const mins = Math.round(minutesSince(runtime.lastGoodAt));
    info(`Holding last known state (${runtime.lastGoodPayload.level}), ${mins}m stale.`);
    return { payload: runtime.lastGoodPayload, stale: true };
  }

  // Never reached the server at all this run - do not invent a shield.
  info('No prior state to hold. Staying clear until first contact.');
  return { payload: { level: 'clear', blocking: false, shieldGroups: [], reasons: [] }, stale: true };
}

/* ----------------------------- notifications ----------------------------- */

async function maybeNotify(payload, stale, cfg) {
  const n = cfg.notifications || {};
  if (!n.enabled) return;

  const level = payload.level || 'clear';
  const changed = level !== runtime.lastAppliedLevel;
  const staleTag = stale && minutesSince(runtime.lastGoodAt) > (cfg.safety?.staleWarnAfterMinutes ?? 30)
    ? ' [STALE - no contact with engine]' : '';

  if (level === 'clear') {
    runtime.nudgeSent = false;
    if (changed && runtime.lastAppliedLevel) {
      await notify('Mellow: clear', 'Everything is unblocked.', n);
      runtime.lastNotifyAt = Date.now();
    }
    return;
  }

  const body = summarise(payload, stale) + staleTag;
  let intervalMin;

  if (level === 'nudge') {
    if (n.nudgeOnce && runtime.nudgeSent && !changed) return;
    runtime.nudgeSent = true;
    intervalMin = 0;
  } else if (level === 'persistent') {
    intervalMin = n.persistentEveryMinutes ?? 15;
  } else {
    intervalMin = n.shieldEveryMinutes ?? 30;
  }

  if (!changed && minutesSince(runtime.lastNotifyAt) < intervalMin) return;

  const titles = {
    nudge: 'Mellow: overdue',
    persistent: 'Mellow: still overdue',
    shield_social: 'Mellow: distractions blocked',
    shield_all: 'Mellow: everything blocked',
  };
  await notify(titles[level] || 'Mellow', body, n);
  runtime.lastNotifyAt = Date.now();
}

/* ---------------------------------- cycle -------------------------------- */

async function cycle(cfg) {
  const result = await fetchEnforcement(cfg);
  const { payload, stale } = decidePayload(result, cfg);
  const level = payload.level || 'clear';

  const set = enforce.resolveBlockSet(payload, cfg);
  const shielding = enforce.isShielding(level);

  if (shielding) {
    info(`level=${level}${stale ? ' (stale)' : ''} :: ` +
         `${set.processes.length} process(es), ${set.domains.length} domain(s), ${set.firewall.length} firewall rule(s)`);
    await enforce.applyBlockSet(set, cfg);
  } else if (runtime.lastAppliedLevel && enforce.isShielding(runtime.lastAppliedLevel)) {
    info(`level=${level} - tearing down previous shield`);
    await enforce.clearAll(cfg);
  } else {
    info(`level=${level}${stale ? ' (stale)' : ''} - nothing to apply`);
  }

  await maybeNotify(payload, stale, cfg);
  runtime.lastAppliedLevel = level;

  return {
    shielding,
    processes: set.processes,
    recheckSeconds: Number(payload.recheckInSeconds) || cfg.server.defaultPollSeconds || 300,
  };
}

/* ---------------------------------- main --------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfg = loadConfig();
  const args = process.argv.slice(2);

  if (args.includes('--clear')) {
    await enforce.clearAll(cfg);
    return;
  }

  if (args.includes('--test-notify')) {
    // Worth having as a first-class command: a notification you never see is
    // indistinguishable from one that was never sent.
    await notify('Mellow: test', 'If you can see this, notifications work.', cfg.notifications);
    info('Test notification sent. If nothing appeared, check Settings > Notifications.');
    return;
  }

  if (args.includes('--notify-agent')) {
    // The enforcement task runs as SYSTEM, in session 0, where a toast is
    // drawn to nobody. This runs in your logged-in session instead and shows
    // whatever SYSTEM left in the queue.
    info('Notification agent started. Watching for queued notifications.');
    for (;;) {
      try {
        await drainQueue(cfg.notifications);
      } catch (e) {
        err(`Notify agent: ${e.message}`);
      }
      await sleep(15000);
    }
  }

  if (args.includes('--status')) {
    const state = util.readJson(cfg.paths.stateFile, null);
    console.log(state ? JSON.stringify(state, null, 2) : 'No state file - nothing applied.');
    return;
  }

  info('--------------------------------------------------');
  info(`Mellow client starting. Endpoint: ${cfg.server.url}`);
  if (cfg.safety?.dryRun) {
    dry('DRY RUN - nothing will actually be blocked. Set safety.dryRun to false when the log looks right.');
  }
  const plat = enforce.platformKey();
  if (process.platform === 'win32' || process.platform === 'darwin') {
    info(`Enforcement backend: ${plat}`);
  } else {
    warn(`Platform is ${process.platform}. Falling back to the ${plat} backend; ` +
         `enforcement calls will mostly no-op. Logic still runs.`);
  }

  if (args.includes('--once')) {
    await cycle(cfg);
    return;
  }

  // Graceful shutdown deliberately does NOT clear the shield.
  // Closing the client should not be a way out.
  const bye = () => { info('Client stopping. Shield state left in place by design.'); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);

  for (;;) {
    let next = 300;
    try {
      const res = await cycle(cfg);
      next = res.recheckSeconds;

      // While shielded, re-kill on a fast loop. Polling every 5 minutes
      // would otherwise hand you a 5-minute play window per relaunch.
      if (res.shielding && res.processes.length) {
        const until = Date.now() + next * 1000;
        while (Date.now() < until) {
          await sleep(10000);
          await enforce.killOnly(res.processes, cfg);
        }
        continue;
      }
    } catch (e) {
      err(`Cycle failed: ${e.stack || e.message}`);
    }
    await sleep(next * 1000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
