'use strict';
/**
 * platform/windows.js - the Windows enforcement backend.
 *
 * Three layers, weakest to strongest:
 *   1. hosts file    - blocks domains browser-wide
 *   2. firewall rule - blocks an .exe from reaching the network
 *   3. process kill  - closes the app
 */

const fs = require('fs');
const { run, info, warn, err, dry, readJson } = require('../util');

const HOSTS_START = '# === RATCHET START - managed automatically, do not edit inside ===';
const HOSTS_END = '# === RATCHET END ===';
const RULE_PREFIX = 'Ratchet-block-';

function stripRatchetBlock(text) {
  const s = text.indexOf(HOSTS_START);
  const e = text.indexOf(HOSTS_END);
  if (s === -1 || e === -1 || e < s) return text;
  const before = text.slice(0, s);
  const after = text.slice(e + HOSTS_END.length);
  return (before.replace(/\s+$/, '') + '\n' + after.replace(/^\s+/, '')).trim() + '\n';
}

async function applyHosts(domains, config) {
  const file = config.paths.hostsFile || 'C:\\Windows\\System32\\drivers\\etc\\hosts';

  if (config.safety?.dryRun) {
    dry(`hosts: would block ${domains.length} domain(s): ${domains.join(', ') || '(none)'}`);
    return true;
  }

  let current;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (e) {
    err(`Cannot read hosts file (${e.message}). Are you running as Administrator?`);
    return false;
  }

  let next = stripRatchetBlock(current);
  if (domains.length > 0) {
    const lines = domains.map((d) => `127.0.0.1 ${d}`).join('\r\n');
    next = next.trimEnd() + '\r\n\r\n' + HOSTS_START + '\r\n' + lines + '\r\n' + HOSTS_END + '\r\n';
  }

  if (next === current) return true;

  try {
    fs.writeFileSync(file, next);
  } catch (e) {
    err(`Cannot write hosts file (${e.message}). Administrator rights are required.`);
    return false;
  }

  await run('ipconfig', ['/flushdns']);
  info(`hosts: ${domains.length} domain(s) blocked`);
  return true;
}

function ruleNameFor(exePath) {
  const base = String(exePath).split('\\').pop().replace(/[^A-Za-z0-9._-]/g, '');
  return RULE_PREFIX + base;
}

async function clearFirewallRules(config) {
  if (config.safety?.dryRun) {
    dry('firewall: would remove all Ratchet rules');
    return;
  }
  const state = readJson(config.paths.stateFile, { firewallRules: [] });
  for (const rule of state.firewallRules || []) {
    await run('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${rule}`]);
  }
}

async function applyFirewall(exePaths, config) {
  if (config.safety?.dryRun) {
    dry(`firewall: would block outbound for ${exePaths.length} exe(s): ${exePaths.join(', ') || '(none)'}`);
    return exePaths.map(ruleNameFor);
  }

  const applied = [];
  for (const exe of exePaths) {
    if (!fs.existsSync(exe)) {
      warn(`firewall: path not found, skipping - ${exe}`);
      continue;
    }
    const name = ruleNameFor(exe);
    const res = await run('netsh', [
      'advfirewall', 'firewall', 'add', 'rule',
      `name=${name}`, 'dir=out', 'action=block',
      `program=${exe}`, 'enable=yes', 'profile=any',
    ]);
    if (res.ok) applied.push(name);
    else err(`firewall: failed to add rule for ${exe} - ${res.stderr.trim() || res.stdout.trim()}`);
  }
  if (applied.length) info(`firewall: ${applied.length} outbound rule(s) active`);
  return applied;
}

async function killProcesses(names, config) {
  if (names.length === 0) return;

  if (config.safety?.dryRun) {
    dry(`processes: would close ${names.join(', ')}`);
    return;
  }

  for (const name of names) {
    const res = await run('taskkill', ['/F', '/IM', name, '/T']);
    if (res.ok) info(`processes: closed ${name}`);
  }
}

module.exports = { applyHosts, applyFirewall, clearFirewallRules, killProcesses, stripRatchetBlock, ruleNameFor };
