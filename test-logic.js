'use strict';
/**
 * test-logic.js - covers the paths where a bug would be expensive:
 * the allowlist, level escalation, the union rule, cross-platform
 * resolution, and hosts-file round-tripping.
 *
 *   node test-logic.js
 */

const enforce = require('./lib/enforce');
const blockset = require('./lib/blockset');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

const cfg = {
  safety: {
    neverBlock: {
      windows: ['explorer.exe', 'msedge.exe'],
      macos: ['Finder', 'Safari'],
    },
  },
  groups: {
    distractions: {
      domains: ['tiktok.com'],
      windows: { processes: ['Discord.exe'], firewall: [] },
      macos: { processes: ['Discord'] },
    },
    games: {
      domains: [],
      windows: { processes: ['steam.exe'], firewall: ['C:\\x\\steam.exe'] },
      macos: { processes: ['Steam'] },
    },
    sneaky: {
      domains: [],
      windows: { processes: ['explorer.exe', 'Discord.exe'] },
      macos: { processes: ['Finder', 'Discord'] },
    },
  },
  shieldAll: { includeGroups: ['distractions', 'games'], extraDomains: [] },
};

const WIN = 'win32', MAC = 'darwin';
const social = (groups) => ({ level: 'shield_social', shieldGroups: groups });

console.log('\nLevel handling');
for (const lvl of ['clear', 'nudge', 'persistent']) {
  check(`${lvl} blocks nothing`,
    blockset.resolveBlockSet({ level: lvl, shieldGroups: ['distractions'] }, cfg, WIN).processes.length === 0);
}
check('shield_social applies only the named group',
  blockset.resolveBlockSet(social(['distractions']), cfg, WIN).processes.join() === 'Discord.exe');
check('shield_all ignores shieldGroups and takes the union',
  blockset.resolveBlockSet({ level: 'shield_all', shieldGroups: [] }, cfg, WIN).processes.length === 2);

console.log('\nCross-platform resolution');
check('Windows resolves .exe names',
  blockset.resolveBlockSet(social(['games']), cfg, WIN).processes.join() === 'steam.exe');
check('macOS resolves app names',
  blockset.resolveBlockSet(social(['games']), cfg, MAC).processes.join() === 'Steam');
check('domains are shared across platforms',
  blockset.resolveBlockSet(social(['distractions']), cfg, MAC).domains.join() === 'tiktok.com');
check('firewall list is Windows-only',
  blockset.resolveBlockSet(social(['games']), cfg, MAC).firewall.length === 0 &&
  blockset.resolveBlockSet(social(['games']), cfg, WIN).firewall.length === 1);
check('platform key is reported back',
  blockset.resolveBlockSet(social(['games']), cfg, MAC).platform === 'macos');

console.log('\nUnion rule (finishing one task must not unlock the other)');
check('two groups union on Windows',
  blockset.resolveBlockSet(social(['distractions', 'games']), cfg, WIN).processes.length === 2);
check('two groups union on macOS',
  blockset.resolveBlockSet(social(['distractions', 'games']), cfg, MAC).processes.length === 2);

console.log('\nAllowlist');
const sneakyWin = blockset.resolveBlockSet(social(['sneaky']), cfg, WIN);
const sneakyMac = blockset.resolveBlockSet(social(['sneaky']), cfg, MAC);
check('explorer.exe refused even when a group names it', !sneakyWin.processes.includes('explorer.exe'));
check('Finder refused even when a group names it', !sneakyMac.processes.includes('Finder'));
check('the rest of that group still applies (win)', sneakyWin.processes.includes('Discord.exe'));
check('the rest of that group still applies (mac)', sneakyMac.processes.includes('Discord'));

console.log('\nBackwards compatibility with the flat config');
const flat = {
  safety: { neverBlock: ['explorer.exe'] },
  groups: { d: { processes: ['Discord.exe'], domains: ['x.com'], firewall: [] } },
  shieldAll: { includeGroups: ['d'] },
};
check('old flat config still resolves on Windows',
  blockset.resolveBlockSet(social(['d']), flat, WIN).processes.join() === 'Discord.exe');
check('old flat allowlist array still honoured',
  !blockset.resolveBlockSet(social(['d']), { ...flat, groups: { d: { processes: ['explorer.exe'] } } }, WIN)
    .processes.includes('explorer.exe'));

console.log('\nDegradation');
check('unknown group returns empty instead of throwing',
  blockset.resolveBlockSet(social(['nope']), cfg, WIN).processes.length === 0);
check('missing macos section degrades to empty, not to the Windows list',
  blockset.resolveBlockSet(social(['d']), flat, MAC).processes.length === 0);

console.log('\nRank ordering');
check('shield_all outranks shield_social',
  blockset.levelRank('shield_all') > blockset.levelRank('shield_social'));
check('isShielding false for persistent', blockset.isShielding('persistent') === false);
check('isShielding true for shield_social', blockset.isShielding('shield_social') === true);
check('unknown level treated as lowest', blockset.levelRank('garbage') === 0);

console.log('\nHosts file round-trip');
const withBlock = '127.0.0.1 localhost\r\n::1 localhost\r\n\r\n' +
  '# === RATCHET START - managed automatically, do not edit inside ===\r\n' +
  '127.0.0.1 tiktok.com\r\n# === RATCHET END ===\r\n';
const stripped = enforce.stripRatchetBlock(withBlock);
check('stripping removes the managed block', !stripped.includes('tiktok.com'));
check('stripping preserves your own entries', stripped.includes('::1 localhost'));

console.log('\nFirewall rule naming');
check('rule name derives from the exe',
  enforce.ruleNameFor('C:\\Program Files (x86)\\Steam\\steam.exe') === 'Ratchet-block-steam.exe');

console.log(`\n${pass} passing, ${fail} failing\n`);
process.exit(fail === 0 ? 0 : 1);
