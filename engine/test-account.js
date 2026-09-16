'use strict';
/**
 * test-account.js - your Mellow account, end to end against a real engine.
 *
 * The engine is copied to a temporary folder and started listening on two
 * loopback addresses: 127.0.0.1 stands for the computer running Mellow, and
 * 127.0.0.2 for a phone on the Wi-Fi. Nothing real is touched.
 *
 *   node test-account.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = 7841;
const PC = '127.0.0.1';
const PHONE = '127.0.0.2';

/** A request as if from the computer (127.0.0.1) or from another device (127.0.0.2). */
function request(method, route, body, { from = PC, headers = {} } = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: from, port: PORT, path: route, method, localAddress: from,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'User-Agent': from === PHONE ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/605' : 'node', ...headers },
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        let j = null; try { j = JSON.parse(out); } catch (_) {}
        resolve({ status: res.statusCode, json: j, text: out });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, text: e.message }));
    req.end(data);
  });
}

function copyEngine(dest) {
  const skip = new Set(['google-tokens.json', 'google-accounts.json', 'auto-tasks.json', 'history.json', 'account.json',
    'google-shared-client.json', 'engine.log', 'app.log', 'google-cache', 'calendar-cache', 'ai-key.txt', 'ai-usage.json',
    'finance.json', 'grades.json', 'drops', 'drops.json', 'assistant']);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(__dirname)) {
    if (skip.has(name) || name.startsWith('client_secret') || name.endsWith('.tmp')) continue;
    fs.cpSync(path.join(__dirname, name), path.join(dest, name), { recursive: true });
  }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mellow-account-'));
  copyEngine(dir);
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ records: [] }));
  fs.writeFileSync(path.join(dir, 'calendars.json'), JSON.stringify({ calendars: [] }));
  fs.writeFileSync(path.join(dir, 'engine-config.json'), JSON.stringify({
    port: PORT, bindHost: [PC, PHONE], token: '', passesPerWeek: 2, name: '',
  }, null, 2));

  const engine = spawn(process.execPath, ['engine.js'], {
    // RATCHET_DATA_DIR pins the copy, so this passes however the test was started.
    cwd: dir, env: { ...process.env, ANTHROPIC_API_KEY: '', RATCHET_DATA_DIR: dir, RATCHET_GOOGLE_TOKEN_URL: 'http://127.0.0.1:9/token' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let engineOut = '';
  engine.stdout.on('data', (c) => (engineOut += c));
  engine.stderr.on('data', (c) => (engineOut += c));

  try {
    for (let i = 0; i < 40; i++) {
      if ((await request('GET', '/api/state')).status === 200) break;
      await sleep(150);
    }
    const reachable = (await request('GET', '/api/state', null, { from: PHONE })).status === 200;
    if (!reachable) {
      console.log('  --    this computer will not talk to itself on 127.0.0.2; the phone half is skipped');
    }

    console.log('\nBefore there is an account');
    let r = await request('GET', '/api/account');
    check('the computer is told it can make one', r.status === 200 && r.json.exists === false && r.json.canCreate === true);
    if (reachable) {
      r = await request('GET', '/api/account', null, { from: PHONE });
      check('another device is told there is none, and that it cannot make it', r.status === 200 && r.json.exists === false && r.json.canCreate === false);
      r = await request('POST', '/api/account/create', { email: 'thief@example.com', password: 'hunter2hunter2' }, { from: PHONE });
      check('and making one from another device is refused', r.status === 400 && /computer running Mellow/.test(r.json.error));
    }

    console.log('\nMaking it');
    r = await request('POST', '/api/account/create', { email: 'Sam@Example.com ', name: 'Sam', password: 'short' });
    check('a short password is refused, with the reason', r.status === 400 && /at least 8/.test(r.json.error));
    r = await request('POST', '/api/account/create', { email: 'not-an-email', password: 'longenough1' });
    check('a bad email address is refused', r.status === 400 && /email address/.test(r.json.error));
    r = await request('POST', '/api/account/create', { email: 'Sam@Example.com ', name: 'Sam', password: 'correct horse 42' });
    const pcToken = r.json && r.json.token;
    check('it is made, and this computer gets a session', r.status === 200 && !!pcToken && r.json.account.email === 'sam@example.com');
    check('the greeting uses the account name', r.json.state && r.json.state.profile.name === 'Sam');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'account.json'), 'utf8'));
    check('the password is not in the file', !JSON.stringify(saved).includes('correct horse 42') && !!saved.account.hash && !!saved.account.salt);
    check('nor is the session token', !JSON.stringify(saved).includes(pcToken));
    r = await request('POST', '/api/account/create', { email: 'someone@else.com', password: 'longenough1' });
    check('a second account cannot be made over the first', r.status === 400 && /already has an account/.test(r.json.error));

    console.log('\nThe computer itself never has to sign in');
    r = await request('GET', '/api/state');
    check('the dashboard opens on this computer without a password', r.status === 200);
    r = await request('POST', '/api/profile', { name: 'Sam' });
    check('and can still change things', r.status === 200);

    if (reachable) {
      console.log('\nA phone on the Wi-Fi');
      r = await request('GET', '/api/state', null, { from: PHONE });
      check('cannot read anything until it signs in', r.status === 401 && r.json.signIn === true);
      r = await request('GET', '/api/grades', null, { from: PHONE });
      check('not even the private pages', r.status === 401);
      r = await request('GET', '/api/account', null, { from: PHONE });
      check('but it can ask whether an account exists, without learning the email', r.status === 200 && r.json.exists === true && !r.json.account);
      r = await request('GET', '/', null, { from: PHONE });
      check('and the page itself still loads, to show the sign-in screen', r.status === 200 && /Mellow/.test(r.text));

      r = await request('POST', '/api/account/signin', { email: 'sam@example.com', password: 'wrong password' }, { from: PHONE });
      check('the wrong password is refused', r.status === 401 && /don't match/.test(r.json.error));
      r = await request('POST', '/api/account/signin', { email: 'someone@else.com', password: 'correct horse 42' }, { from: PHONE });
      check('so is the right password on the wrong email, with the same wording', r.status === 401 && /don't match/.test(r.json.error));
      for (let i = 0; i < 4; i++) await request('POST', '/api/account/signin', { email: 'sam@example.com', password: 'nope' }, { from: PHONE });
      r = await request('POST', '/api/account/signin', { email: 'sam@example.com', password: 'correct horse 42' }, { from: PHONE });
      check('guessing over and over is slowed down, even with the right password', r.status === 429 && /Wait/.test(r.json.error));
      check('and the computer is not slowed down with it', (await request('POST', '/api/account/signin', { email: 'sam@example.com', password: 'correct horse 42' })).status === 200);

      // The wait is short at five tries; let it pass rather than guess at the clock.
      await sleep(16000);
      r = await request('POST', '/api/account/signin', { email: ' SAM@example.com', password: 'correct horse 42' }, { from: PHONE });
      const phoneToken = r.json && r.json.token;
      check('the right email and password get in, however the email is typed', r.status === 200 && !!phoneToken);
      check('the phone names itself in the device list', (r.json.account.devices || []).some((d) => /iPhone/.test(d.device)));
      r = await request('GET', '/api/state', null, { from: PHONE, headers: { 'X-Mellow-Session': phoneToken } });
      check('with its session it can read', r.status === 200);
      r = await request('POST', '/api/complete', { taskId: 'nope' }, { from: PHONE, headers: { 'X-Mellow-Session': phoneToken } });
      check('and write', r.status !== 401);
      r = await request('GET', '/api/state', null, { from: PHONE, headers: { 'X-Mellow-Session': `${phoneToken}x` } });
      check('a made-up session is refused', r.status === 401);

      console.log('\nTaking access back');
      r = await request('POST', '/api/account/password', { next: 'a different one 9' }, { from: PHONE, headers: { 'X-Mellow-Session': phoneToken } });
      check('a device must give the old password to change it', r.status === 400 && /current password/.test(r.json.error));
      r = await request('POST', '/api/account/password', { current: 'not it', next: 'a different one 9' }, { from: PHONE, headers: { 'X-Mellow-Session': phoneToken } });
      check('and the wrong old password changes nothing', r.status === 400 && /isn\'t your current password/.test(r.json.error));
      r = await request('POST', '/api/account/password', { current: 'correct horse 42', next: 'a different one 9' }, { from: PHONE, headers: { 'X-Mellow-Session': phoneToken } });
      check('with the old password it changes', r.status === 200);
      check('the phone that changed it stays signed in', (await request('GET', '/api/state', null, { from: PHONE, headers: { 'X-Mellow-Session': phoneToken } })).status === 200);
      check('every other device is signed out', (await request('GET', '/api/account', null, { headers: { 'X-Mellow-Session': pcToken } })).json.account.devices.length === 1);
      r = await request('POST', '/api/account/signin', { email: 'sam@example.com', password: 'correct horse 42' });
      check('the old password no longer works', r.status === 401);

      console.log('\nSigning a device out from the computer');
      const devices = (await request('GET', '/api/account')).json.account.devices;
      r = await request('POST', '/api/account/device/revoke', { id: devices[0].id });
      check('the device is removed from the list', r.status === 200 && r.json.account.devices.length === 0);
      check('and its session stops working at once', (await request('GET', '/api/state', null, { from: PHONE, headers: { 'X-Mellow-Session': phoneToken } })).status === 401);
    }

    console.log('\nWhat the account is not');
    r = await request('GET', '/api/account');
    check('the password is never sent out, even to the computer', !JSON.stringify(r.json).includes('hash') && !JSON.stringify(r.json).includes('salt'));
    check('the email and name are, once you are in', r.json.account.email === 'sam@example.com' && r.json.account.name === 'Sam');
    r = await request('POST', '/api/account/profile', { name: 'Samira' });
    check('the name can be changed', r.status === 200 && r.json.state.profile.name === 'Samira');
    check('and engine-config.json keeps it for the greeting', JSON.parse(fs.readFileSync(path.join(dir, 'engine-config.json'), 'utf8')).name === 'Samira');
  } catch (e) {
    fail++;
    console.log(`  FAIL  threw: ${e.stack}`);
  } finally {
    engine.kill();
    await sleep(300);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n${pass} passing, ${fail} failing\n`);
  if (fail) console.log('--- engine output ---\n' + engineOut);
  process.exit(fail === 0 ? 0 : 1);
})();
