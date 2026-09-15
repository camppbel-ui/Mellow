'use strict';
/**
 * enforce.js - platform dispatcher.
 *
 * Picks a backend at runtime so the same codebase runs on the PC (host) and
 * the Mac (client). All shared decision logic lives in blockset.js; only the
 * applying is platform-specific.
 */

const { info, err, writeJson } = require('./util');
const blockset = require('./blockset');

const BACKENDS = {
  windows: require('./platform/windows'),
  macos: require('./platform/macos'),
};

function backendFor(plat) {
  const key = blockset.platformKey(plat);
  return { key, impl: BACKENDS[key] };
}

/**
 * Apply a resolved block set using the right backend. Returns true on success.
 */
async function applyBlockSet(set, config, plat) {
  const { key, impl } = backendFor(plat);

  const okHosts = await impl.applyHosts(set.domains, config);

  await impl.clearFirewallRules(config);
  const rules = await impl.applyFirewall(set.firewall, config);

  writeJson(config.paths.stateFile, {
    updatedAt: new Date().toISOString(),
    platform: key,
    firewallRules: rules,
    domains: set.domains,
    processes: set.processes,
  });

  await impl.killProcesses(set.processes, config);
  return okHosts;
}

/** Kill only. Used by the fast watchdog loop between server polls. */
async function killOnly(processes, config, plat) {
  const { impl } = backendFor(plat);
  await impl.killProcesses(processes, config);
}

/** Remove everything Mellow has applied. Safe to call repeatedly. */
async function clearAll(config, plat) {
  const { key, impl } = backendFor(plat);
  await impl.applyHosts([], config);
  await impl.clearFirewallRules(config);
  writeJson(config.paths.stateFile, {
    updatedAt: new Date().toISOString(),
    platform: key,
    firewallRules: [],
    domains: [],
    processes: [],
  });
  info('shield cleared - nothing is blocked');
}

module.exports = {
  LEVELS: blockset.LEVELS,
  levelRank: blockset.levelRank,
  isShielding: blockset.isShielding,
  resolveBlockSet: blockset.resolveBlockSet,
  platformKey: blockset.platformKey,
  stripRatchetBlock: BACKENDS.windows.stripRatchetBlock,
  ruleNameFor: BACKENDS.windows.ruleNameFor,
  applyBlockSet, clearAll, killOnly,
};
