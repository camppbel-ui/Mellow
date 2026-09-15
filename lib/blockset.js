'use strict';
/**
 * blockset.js - the platform-independent half of enforcement.
 *
 * Turning { level, shieldGroups } into "what should be blocked" is identical
 * on Windows and macOS. Only the applying differs. Keeping this separate means
 * the union rule and the allowlist are tested once and behave the same on both
 * machines.
 */

const { warn } = require('./util');

const LEVELS = ['clear', 'nudge', 'persistent', 'shield_social', 'shield_all'];

function levelRank(level) {
  const i = LEVELS.indexOf(level);
  return i === -1 ? 0 : i;
}

function isShielding(level) {
  return levelRank(level) >= LEVELS.indexOf('shield_social');
}

/** 'win32' -> 'windows', 'darwin' -> 'macos' */
function platformKey(plat = process.platform) {
  if (plat === 'win32') return 'windows';
  if (plat === 'darwin') return 'macos';
  return 'windows'; // sandbox/testing default
}

/**
 * Read a group's per-platform section, falling back to flat keys so an older
 * config.json (processes/firewall at the top level) still works.
 */
function groupFor(group, key) {
  const p = group[key] || {};
  return {
    processes: p.processes || (key === 'windows' ? group.processes || [] : []),
    firewall: p.firewall || (key === 'windows' ? group.firewall || [] : []),
    domains: group.domains || [],
  };
}

/**
 * Resolve a server payload into concrete things to block on THIS machine.
 * Honours the neverBlock allowlist unconditionally.
 */
function resolveBlockSet(payload, config, plat) {
  const key = platformKey(plat);
  const out = { processes: new Set(), domains: new Set(), firewall: new Set() };

  const level = payload.level || 'clear';
  if (!isShielding(level)) return { processes: [], domains: [], firewall: [], platform: key };

  let groupNames;
  if (level === 'shield_all') {
    groupNames = config.shieldAll?.includeGroups || Object.keys(config.groups || {});
  } else {
    groupNames = Array.isArray(payload.shieldGroups) ? payload.shieldGroups : [];
  }

  for (const name of groupNames) {
    if (name === '_comment') continue;
    const g = (config.groups || {})[name];
    if (!g) {
      warn(`Server asked for group "${name}" but config.json has no such group. Ignored.`);
      continue;
    }
    const part = groupFor(g, key);
    part.processes.forEach((p) => out.processes.add(p));
    part.domains.forEach((d) => out.domains.add(d));
    part.firewall.forEach((f) => out.firewall.add(f));
  }

  if (level === 'shield_all') {
    const extra = config.shieldAll || {};
    (extra.extraProcesses?.[key] || extra.extraProcesses || []).forEach?.((p) => out.processes.add(p));
    (extra.extraDomains || []).forEach((d) => out.domains.add(d));
  }

  // Allowlist wins over everything, on both platforms.
  const never = new Set([
    ...(config.safety?.neverBlock?.[key] || config.safety?.neverBlock || []),
  ].map((s) => String(s).toLowerCase()));

  for (const p of [...out.processes]) {
    if (never.has(p.toLowerCase())) {
      warn(`"${p}" is in neverBlock - refusing to block it.`);
      out.processes.delete(p);
    }
  }

  return {
    processes: [...out.processes],
    domains: [...out.domains],
    firewall: [...out.firewall],
    platform: key,
  };
}

module.exports = { LEVELS, levelRank, isShielding, resolveBlockSet, platformKey, groupFor };
