'use strict';
/**
 * test-updates.js - installing a release: what gets replaced, what is kept,
 * and what is refused. Everything happens in a scratch folder; nothing is
 * downloaded and this copy of Mellow is never touched.
 *
 *   node test-updates.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const updates = require('./lib/updates');
const { checkSyntax } = require('./lib/ai/assistant');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}
function throws(fn, re) {
  try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; }
}

/* A zip made the way the packager makes one: deflated entries under Mellow/. */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeZip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const release = (version, extra = {}) => ({
  'Mellow/engine/engine.js': `// engine ${version}\nmodule.exports = 1;\n`,
  'Mellow/engine/dashboard.html': `<html><script>var v = "${version}";</script></html>`,
  'Mellow/engine/version.json': JSON.stringify({ version, repo: 'camppbel-ui/Mellow', site: 'https://mellow-track.com' }),
  'Mellow/engine/tasks.json': '{"tasks":[{"id":"example"}]}',
  'Mellow/engine/lib/new-feature.js': 'module.exports = "new";\n',
  'Mellow/start-ratchet.cmd': '@echo off\r\necho new launcher\r\n',
  'Mellow/README.md': `# Mellow ${version}\n`,
  ...extra,
});

function scratchApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mellow-upd-'));
  const w = (rel, text) => { const abs = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); };
  w('engine/engine.js', '// engine 2026.09.15\nmodule.exports = 1;\n');
  w('engine/dashboard.html', '<html><script>var v = "2026.09.15";</script></html>');
  w('engine/version.json', JSON.stringify({ version: '2026.09.15' }));
  w('engine/tasks.json', '{"tasks":[{"id":"my-own-laundry"}]}');
  w('engine/finance.json', '{"accounts":[{"name":"mine"}]}');
  w('engine/ai-key.txt', 'sk-ant-secret');
  w('start-ratchet.cmd', '@echo off\r\necho old launcher\r\n');
  w('README.md', '# Mellow 2026.09.15\n');
  return dir;
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');

console.log('\nVersions');
check('a later date is newer', updates.compareVersions('2026.09.20', '2026.09.15') === 1);
check('a second release the same day is newer', updates.compareVersions('2026.09.15.2', '2026.09.15') === 1);
check('a leading v is ignored', updates.compareVersions('v2026.09.15', '2026.09.15') === 0);
check('an older one is not', updates.compareVersions('2026.08.30', '2026.09.15') === -1);

console.log('\nInstalling a release');
{
  const app = scratchApp();
  const state = path.join(app, 'state.json');
  const r = updates.install(makeZip(release('2026.09.20')), { expectVersion: '2026.09.20', appDir: app, stateFile: state, checkSyntax });
  check('code is replaced', read(app, 'engine/engine.js').includes('2026.09.20') && read(app, 'engine/dashboard.html').includes('2026.09.20'));
  check('new files arrive', read(app, 'engine/lib/new-feature.js').includes('new'));
  check('the version moves on', JSON.parse(read(app, 'engine/version.json')).version === '2026.09.20');
  check('your tasks are kept, not replaced by the example ones', read(app, 'engine/tasks.json').includes('my-own-laundry'));
  check('data the release doesn\'t have is untouched', read(app, 'engine/finance.json').includes('mine') && read(app, 'engine/ai-key.txt') === 'sk-ant-secret');
  check('a running launcher is written beside itself', read(app, 'start-ratchet.cmd').includes('old launcher') && read(app, 'start-ratchet.cmd.new').includes('new launcher'));
  check('it reports what happened', r.from === '2026.09.15' && r.to === '2026.09.20' && r.kept === 1 && r.written >= 5);
  check('and records the update', JSON.parse(fs.readFileSync(state, 'utf8')).lastUpdate.to === '2026.09.20');
  const again = updates.install(makeZip(release('2026.09.20')), { appDir: app, stateFile: state });
  check('the same release twice changes nothing new', again.unchanged >= 4 && again.written <= 1);
  fs.rmSync(app, { recursive: true, force: true });
}

console.log('\nRefused');
{
  const app = scratchApp();
  const opts = { appDir: app, stateFile: path.join(app, 'state.json'), checkSyntax };
  check('a path that climbs out of the folder', throws(() => updates.install(makeZip(release('2026.09.20', { 'Mellow/../evil.js': 'x' })), opts), /unsafe path/));
  check('a file outside Mellow/', throws(() => updates.install(makeZip({ ...release('2026.09.20'), 'other/thing.js': 'x' }), opts), /unexpected file/));
  const noEngine = release('2026.09.20');
  delete noEngine['Mellow/engine/engine.js'];
  check('a release missing the engine', throws(() => updates.install(makeZip(noEngine), opts), /missing parts/));
  check('a release that isn\'t the version it claims', throws(() => updates.install(makeZip(release('2026.09.19')), { ...opts, expectVersion: '2026.09.20' }), /says it is/));
  check('broken code, and nothing is written', throws(() => updates.install(makeZip(release('2026.09.20', { 'Mellow/engine/lib/broken.js': 'function (' })), opts), /doesn't parse/) &&
    read(app, 'engine/engine.js').includes('2026.09.15') && !fs.existsSync(path.join(app, 'engine', 'lib', 'new-feature.js')));
  check('damaged bytes', throws(() => updates.install(Buffer.from('not a zip at all'), opts), /not a zip/));
  const sneaky = updates.install(makeZip(release('2026.09.20', { 'Mellow/engine/ai-key.txt': 'sk-ant-attacker', 'Mellow/engine/assistant/conversations/x.json': '{}' })), opts);
  check('keys and conversations in a zip are never written', read(app, 'engine/ai-key.txt') === 'sk-ant-secret' && !fs.existsSync(path.join(app, 'engine', 'assistant')) && sneaky.to === '2026.09.20');
  fs.rmSync(app, { recursive: true, force: true });
}

console.log('\nThis copy');
{
  const me = updates.local();
  check('knows its version and where releases come from', /^\d{4}\.\d{2}\.\d{2}/.test(me.version) && me.repo === 'camppbel-ui/Mellow' && me.site === 'https://mellow-track.com');
  check('settings files are kept, version.json is not', updates.keepExisting('engine/tasks.json') && updates.keepExisting('config.json') && !updates.keepExisting('engine/version.json'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
