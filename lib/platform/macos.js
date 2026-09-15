'use strict';
/**
 * platform/macos.js - the macOS enforcement backend.
 *
 * Honest limitation up front: macOS has no clean per-app outbound firewall you
 * can drive from a script. Apple's socketfilterfw only blocks INCOMING
 * connections, and pf rules cannot target an application, only addresses and
 * ports. So the firewall layer that exists on Windows has no equivalent here.
 *
 * That leaves two layers instead of three: hosts file for sites, process
 * termination for apps. In practice this is most of the value - the Windows
 * firewall layer is a nicety that lets a launcher stay open but disconnected.
 */

const fs = require('fs');
const { run, info, warn, err, dry } = require('../util');

const HOSTS_START = '# === RATCHET START - managed automatically, do not edit inside ===';
const HOSTS_END = '# === RATCHET END ===';

function stripRatchetBlock(text) {
  const s = text.indexOf(HOSTS_START);
  const e = text.indexOf(HOSTS_END);
  if (s === -1 || e === -1 || e < s) return text;
  const before = text.slice(0, s);
  const after = text.slice(e + HOSTS_END.length);
  return (before.replace(/\s+$/, '') + '\n' + after.replace(/^\s+/, '')).trim() + '\n';
}

async function applyHosts(domains, config) {
  const file = config.paths.hostsFileMac || '/etc/hosts';

  if (config.safety?.dryRun) {
    dry(`hosts: would block ${domains.length} domain(s): ${domains.join(', ') || '(none)'}`);
    return true;
  }

  let current;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (e) {
    err(`Cannot read ${file} (${e.message}). The client must run with sudo/root.`);
    return false;
  }

  let next = stripRatchetBlock(current);
  if (domains.length > 0) {
    const lines = domains.map((d) => `127.0.0.1 ${d}`).join('\n');
    next = next.trimEnd() + '\n\n' + HOSTS_START + '\n' + lines + '\n' + HOSTS_END + '\n';
  }

  if (next === current) return true;

  try {
    fs.writeFileSync(file, next);
  } catch (e) {
    err(`Cannot write ${file} (${e.message}). Root is required.`);
    return false;
  }

  // macOS caches DNS aggressively; without this the block looks broken.
  await run('dscacheutil', ['-flushcache']);
  await run('killall', ['-HUP', 'mDNSResponder']);
  info(`hosts: ${domains.length} domain(s) blocked`);
  return true;
}

/**
 * No-op. Kept so the two backends share an interface and enforce.js does not
 * need to know which platform it is on.
 */
async function applyFirewall(paths, config) {
  if (paths.length) {
    warn(`firewall: ${paths.length} rule(s) requested but macOS has no scriptable ` +
         `per-app outbound blocking. Relying on process termination instead.`);
  }
  return [];
}

async function clearFirewallRules() {
  return;
}

async function killProcesses(names, config) {
  if (names.length === 0) return;

  if (config.safety?.dryRun) {
    dry(`processes: would quit ${names.join(', ')}`);
    return;
  }

  for (const name of names) {
    // Try a graceful quit first so unsaved work is not destroyed.
    const clean = String(name).replace(/"/g, '');
    const gentle = await run('osascript', ['-e', `tell application "${clean}" to quit`]);
    if (!gentle.ok) {
      // Not scriptable, or already gone. Fall back to a signal.
      await run('pkill', ['-x', clean]);
    }
    info(`processes: closed ${name}`);
  }
}

module.exports = { applyHosts, applyFirewall, clearFirewallRules, killProcesses, stripRatchetBlock };
