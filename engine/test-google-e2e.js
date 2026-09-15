'use strict';
/**
 * test-google-e2e.js - the whole Google path, end to end, against a fake Google.
 *
 * Copies the engine to a temporary folder so nothing real is touched - no
 * tokens, no history, no accounts - then runs the real sign-in callback, the
 * real sync and the real API against a local stand-in for Gmail and Calendar.
 *
 *   node test-google-e2e.js
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

const MOCK_PORT = 7821;
const ENGINE_PORT = 7831;
const ME = 'student@utexas.edu';
const now = Date.now();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function inDays(n, h, m = 0) {
  const d = new Date(now);
  d.setDate(d.getDate() + n);
  d.setHours(h, m, 0, 0);
  return d;
}
const b64 = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

/* ------------------------------ fake google ------------------------------ */

const psetDue = inDays(3, 23, 59);
const messages = {
  m1: {
    id: 'm1', threadId: 'x1', internalDate: String(now - 3600000), labelIds: ['INBOX'],
    payload: {
      headers: [
        { name: 'From', value: 'Canvas <notifications@instructure.com>' },
        { name: 'Subject', value: 'Assignment Created - Problem Set 3, M 408C' },
        { name: 'List-Unsubscribe', value: '<mailto:x@instructure.com>' },
      ],
      mimeType: 'text/plain',
      body: { data: b64(`A new assignment has been created.\n\nProblem Set 3, M 408C\n\ndue: ${MONTHS[psetDue.getMonth()]} ${psetDue.getDate()} at 11:59pm`) },
    },
  },
  m2: {
    id: 'm2', threadId: 'x2', internalDate: String(now - 7200000), labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
    payload: {
      headers: [
        { name: 'From', value: 'Grammarly <hello@mail.grammarly.com>' },
        { name: 'Subject', value: 'Homework deadline? 50% off Pro' },
      ],
      mimeType: 'text/plain', body: { data: b64('Offer due tomorrow!') },
    },
  },
};

const threads = {
  t1: {
    id: 't1', messages: [{
      id: 'tm1', internalDate: String(now - 30 * 3600000), labelIds: ['INBOX'],
      payload: { headers: [
        { name: 'From', value: 'Alex Kim <alex@utexas.edu>' },
        { name: 'To', value: ME },
        { name: 'Subject', value: 'Lab partner for Friday?' },
      ] },
    }],
  },
  t2: {
    id: 't2', messages: [{
      id: 'tm2', internalDate: String(now - 3600000), labelIds: ['INBOX'],
      payload: { headers: [
        { name: 'From', value: 'UT News <news@utexas.edu>' },
        { name: 'To', value: ME },
        { name: 'Subject', value: 'This week on campus' },
        { name: 'List-Unsubscribe', value: '<mailto:u@utexas.edu>' },
      ] },
    }],
  },
};

const events = [
  { id: 'e1', summary: 'M 408C Lecture', recurringEventId: 'r1', status: 'confirmed',
    start: { dateTime: inDays(1, 11).toISOString() }, end: { dateTime: inDays(1, 12, 15).toISOString() }, location: 'RLM 4.102' },
  { id: 'e2', summary: 'BIO 311C Midterm 1', status: 'confirmed',
    start: { dateTime: inDays(4, 19).toISOString() }, end: { dateTime: inDays(4, 21).toISOString() }, location: 'Gregory Gym' },
  { id: 'e3', summary: 'Declined meeting', status: 'confirmed', attendees: [{ self: true, responseStatus: 'declined' }],
    start: { dateTime: inDays(1, 15).toISOString() }, end: { dateTime: inDays(1, 16).toISOString() } },
];

const seen = { tokenCalls: 0, apiCalls: 0, lastAuth: '' };

const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };

  if (u.pathname === '/token') {
    seen.tokenCalls++;
    return json({ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600, scope: 'x' });
  }

  seen.apiCalls++;
  seen.lastAuth = req.headers.authorization || '';
  if (req.headers.authorization !== 'Bearer fake-access') return json({ error: { message: 'bad auth' } }, 401);

  const p = u.pathname;
  if (p === '/gmail/v1/users/me/profile') return json({ emailAddress: ME });
  if (p === '/gmail/v1/users/me/settings/sendAs') return json({ sendAs: [{ sendAsEmail: ME }] });
  if (p === '/gmail/v1/users/me/messages') return json({ messages: Object.keys(messages).map((id) => ({ id })) });
  if (p.startsWith('/gmail/v1/users/me/messages/')) return json(messages[p.split('/').pop()] || {}, messages[p.split('/').pop()] ? 200 : 404);
  if (p === '/gmail/v1/users/me/threads') return json({ threads: Object.keys(threads).map((id) => ({ id, historyId: '1' })) });
  if (p.startsWith('/gmail/v1/users/me/threads/')) return json(threads[p.split('/').pop()] || {});
  if (p === '/calendar/v3/users/me/calendarList') {
    return json({ items: [{ id: ME, summary: ME, selected: true, backgroundColor: '#2f5f8a' }] });
  }
  if (p.startsWith('/calendar/v3/calendars/')) return json({ items: events });
  return json({ error: { message: `no mock for ${p}` } }, 404);
});

/* --------------------------------- helpers -------------------------------- */

function request(method, route, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      host: '127.0.0.1', port: ENGINE_PORT, path: route, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function copyEngine(dest) {
  // No AI key and no finances: a sync reads billing emails with Claude, and a test must never spend money.
  const skip = new Set(['google-tokens.json', 'google-accounts.json', 'auto-tasks.json', 'history.json',
    'engine.log', 'google-cache', 'calendar-cache', 'ai-key.txt', 'ai-usage.json', 'finance.json', 'drops', 'drops.json', 'assistant']);
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(__dirname)) {
    if (skip.has(name) || name.startsWith('client_secret') || name.endsWith('.tmp')) continue;
    const from = path.join(__dirname, name);
    fs.cpSync(from, path.join(dest, name), { recursive: true });
  }
}

/* ---------------------------------- run ---------------------------------- */

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-e2e-'));
  copyEngine(dir);
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ records: [] }));
  fs.writeFileSync(path.join(dir, 'engine-config.json'), JSON.stringify({
    port: ENGINE_PORT, bindHost: '127.0.0.1', token: 'not-needed-from-loopback', passesPerWeek: 2,
  }));
  fs.writeFileSync(path.join(dir, 'calendars.json'), JSON.stringify({ calendars: [] }));

  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  const engine = spawn(process.execPath, ['engine.js'], {
    cwd: dir,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: '',
      RATCHET_GOOGLE_TOKEN_URL: `http://127.0.0.1:${MOCK_PORT}/token`,
      RATCHET_GOOGLE_AUTH_URL: `http://127.0.0.1:${MOCK_PORT}/auth`,
      RATCHET_GOOGLE_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let engineOut = '';
  engine.stdout.on('data', (c) => (engineOut += c));
  engine.stderr.on('data', (c) => (engineOut += c));

  try {
    for (let i = 0; i < 40; i++) {
      if ((await request('GET', '/api/state')).status === 200) break;
      await sleep(150);
    }

    console.log('\nBefore any client file');
    let st = await request('GET', '/api/google/status');
    check('status reports no client', st.json && st.json.client.ok === false);
    let r = await request('POST', '/api/google/connect', { role: 'school' });
    check('connect is refused with a pointer to the setup guide', r.status === 400 && /GOOGLE-SETUP/.test(r.json.error));

    console.log('\nWith a Web client by mistake');
    fs.writeFileSync(path.join(dir, 'client_secret_wrong.json'), JSON.stringify({ web: { client_id: 'w' } }));
    st = await request('GET', '/api/google/status');
    check('a Web client is rejected with the reason', st.json.client.ok === false && /Desktop app/.test(st.json.client.error));
    fs.unlinkSync(path.join(dir, 'client_secret_wrong.json'));

    console.log('\nSigning in');
    fs.writeFileSync(path.join(dir, 'client_secret_123-abc.apps.googleusercontent.com.json'),
      JSON.stringify({ installed: { client_id: '123-abc.apps.googleusercontent.com', client_secret: 'shh' } }));
    st = await request('GET', '/api/google/status');
    check('the downloaded client file is found without renaming', st.json.client.ok === true);

    r = await request('POST', '/api/google/connect', { role: 'school' });
    check('connect returns a Google URL', r.status === 200 && /\/auth\?/.test(r.json.url));
    const authUrl = new URL(r.json.url);
    check('the URL asks for read-only scopes only',
      authUrl.searchParams.get('scope') === 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly');
    check('the URL uses PKCE', authUrl.searchParams.get('code_challenge_method') === 'S256');
    check('the URL asks for offline access', authUrl.searchParams.get('access_type') === 'offline');
    check('the redirect is the loopback callback',
      authUrl.searchParams.get('redirect_uri') === `http://127.0.0.1:${ENGINE_PORT}/oauth/callback`);

    const bad = await request('GET', '/oauth/callback?code=x&state=forged');
    check('a callback with a forged state is refused', bad.status === 400 && /expired/i.test(bad.text));

    const denied = await request('GET', `/oauth/callback?error=access_denied&state=${authUrl.searchParams.get('state')}`);
    check('a declined consent says so plainly', denied.status === 400 && /declined/i.test(denied.text));

    r = await request('POST', '/api/google/connect', { role: 'school' });
    const state2 = new URL(r.json.url).searchParams.get('state');
    const cb = await request('GET', `/oauth/callback?code=goodcode&state=${state2}`);
    check('a real callback connects the account', cb.status === 200 && cb.text.includes(ME));
    check('the code was exchanged for tokens', seen.tokenCalls >= 1);

    const replay = await request('GET', `/oauth/callback?code=goodcode&state=${state2}`);
    check('the same callback cannot be replayed', replay.status === 400);

    console.log('\nSyncing');
    r = await request('POST', '/api/google/sync', {});
    check('sync completes', r.status === 200);
    check('API calls carried the access token', seen.lastAuth === 'Bearer fake-access');

    st = await request('GET', '/api/google/status');
    const acct = st.json.accounts[0];
    check('the account is listed as school', acct && acct.email === ME && acct.role === 'school');
    check('the sync reported no errors', acct && !acct.lastError);
    check('no token material is exposed in status', !JSON.stringify(st.json).includes('fake-refresh'));

    const state = (await request('GET', '/api/state')).json;
    const pset = state.tasks.find((t) => /Problem Set 3/.test(t.title));
    check('the Canvas email became a homework task', !!pset && pset.group === 'school');
    check('with its course', pset && pset.course === 'M 408C');
    check('arriving unconfirmed', pset && pset.confirmed === false && pset.auto === true);
    check('the promo email did not become a task', !state.tasks.some((t) => /Grammarly|50%/.test(t.title)));
    const exam = state.tasks.find((t) => /Midterm/.test(t.title));
    check('the exam on the calendar became an exam task', exam && exam.kind === 'exam');
    check('the recurring lecture did not become a task', !state.tasks.some((t) => /Lecture/.test(t.title)));
    const email = state.tasks.find((t) => t.group === 'email');
    check('one thread is waiting on a reply', email && email.threads.length === 1 && /Lab partner/.test(email.threads[0].subject));
    check('the newsletter is not waiting on a reply', email && !email.threads.some((t) => /campus/.test(t.subject)));

    console.log('\nThe calendar');
    const cal = (await request('GET', '/api/calendar?days=14')).json;
    const all = cal.days.flatMap((d) => d.items);
    check('Google events appear on the calendar', all.some((i) => i.type === 'event' && /Lecture/.test(i.title)));
    check('a declined event is hidden', !all.some((i) => /Declined/.test(i.title)));
    check('homework deadlines appear on their day', all.some((i) => i.type === 'deadline' && /Problem Set 3/.test(i.title)));
    check('the calendar starts today and runs fourteen days', cal.days.length === 14);
    check('no token material in the calendar either', !JSON.stringify(cal).includes('fake-'));

    console.log('\nDeciding about what was captured');
    r = await request('POST', '/api/auto/confirm', { key: pset.id });
    const confirmed = r.json.state.tasks.find((t) => t.id === pset.id);
    check('confirming makes it able to shield', confirmed && confirmed.confirmed === true);

    r = await request('POST', '/api/auto/dismiss', { key: exam.id });
    check('dismissing removes it', !r.json.state.tasks.some((t) => t.id === exam.id));
    await request('POST', '/api/google/sync', {});
    const again = (await request('GET', '/api/state')).json;
    check('and a re-sync does not bring it back', !again.tasks.some((t) => t.id === exam.id));

    r = await request('POST', '/api/complete', { taskId: pset.id });
    check('homework can be marked done', r.status === 200);
    const doneTask = r.json.state.tasks.find((t) => t.id === pset.id);
    check('and shows as done', doneTask && doneTask.done === true && doneTask.level === 'clear');

    r = await request('POST', '/api/pass', { taskId: email.id });
    check('passes cannot be spent on email', r.status === 400);

    r = await request('POST', '/api/complete', { taskId: email.id });
    check('"Done" on email clears those threads', r.status === 200 && !r.json.state.tasks.some((t) => t.group === 'email'));
    r = await request('POST', '/api/emails/undo', {});
    check('and can be undone', r.status === 200 && r.json.state.tasks.some((t) => t.group === 'email'));

    console.log('\nDisconnecting');
    r = await request('POST', '/api/google/disconnect', { email: ME });
    check('disconnect succeeds', r.status === 200);
    const tokensLeft = fs.existsSync(path.join(dir, 'google-tokens.json'))
      ? JSON.parse(fs.readFileSync(path.join(dir, 'google-tokens.json'), 'utf8')) : {};
    check('its tokens are deleted from disk', !tokensLeft[ME]);
    check('its unconfirmed captures are forgotten',
      !r.json.state.tasks.some((t) => t.auto && !t.confirmed));

    console.log('\nWhat never gets served');
    for (const f of ['/google-tokens.json', '/google-accounts.json', '/auto-tasks.json', '/client_secret_123-abc.apps.googleusercontent.com.json']) {
      const s = await request('GET', f);
      check(`${f} is not downloadable`, s.status === 404);
    }
  } catch (e) {
    fail++;
    console.log(`  FAIL  threw: ${e.stack}`);
    console.log(engineOut);
  } finally {
    engine.kill();
    mock.close();
    await sleep(300);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(`\n${pass} passing, ${fail} failing\n`);
  if (fail) console.log('--- engine output ---\n' + engineOut);
  process.exit(fail === 0 ? 0 : 1);
})();
