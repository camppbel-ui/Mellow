'use strict';
/**
 * test-ai.js - file drops, the assistant's guard rails, AI privacy and credit
 * cards. Claude is replaced with a script, so this runs offline, costs
 * nothing, and never needs an API key.
 *
 *   node test-ai.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const privacy = require('./lib/ai/privacy');
const claude = require('./lib/ai/claude');
const drops = require('./lib/drops');
const zip = require('./lib/zip');
const finance = require('./lib/finance');
const news = require('./lib/news');
const assistant = require('./lib/ai/assistant');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

(async () => {
  console.log('\nRedaction');
  {
    const r = privacy.redact('Visa 4111 1111 1111 1111, SSN 123-45-6789, Account number: 000123456789, call 860-555-1234, order 88812');
    check('a card number keeps only its last four', r.includes('[card ending 1111]') && !r.includes('4111 1111'));
    check('a Social Security number is removed', r.includes('[SSN removed]'));
    check('a labelled account number is masked', r.includes('[number ending 6789]') && !r.includes('000123456789'));
    check('a phone number and an order number are left alone', r.includes('860-555-1234') && r.includes('88812'));
    check('sixteen digits that fail the card checksum are left alone', privacy.redact('ref 1234 5678 9012 3456').includes('1234 5678 9012 3456'));
  }

  console.log('\nWhat Claude may see of your finances');
  {
    const fin = {
      settings: { ai: { bills: true, cards: false, transactions: false } },
      accounts: [{ id: 'c1', type: 'credit', name: 'Card' }],
      bills: [{ id: 'b1', private: true }],
      transactions: [{ date: '2026-09-01', description: 'Pizza', amount: -12 }],
      summary: {
        upcoming: [
          { billId: 'b1', name: 'Secret', amount: 10, date: '2026-09-20' },
          { billId: 'b2', name: 'Phone', amount: 45, date: '2026-09-21' },
          { billId: 'b3', cardId: 'c1', name: 'Card payment', amount: 200, date: '2026-09-22' },
        ],
        cards: [{ name: 'Card', balance: 900, last4: '4242' }],
        netWorth: 5000,
      },
    };
    const v = privacy.financeForAi(fin);
    check('shared bills are included', v.upcomingBills.some((b) => b.name === 'Phone'));
    check('a bill marked private is not', !v.upcomingBills.some((b) => b.name === 'Secret'));
    check('a card payment stays out while cards are private', !v.upcomingBills.some((b) => b.name === 'Card payment'));
    check('cards, transactions and net worth are absent, not summarised', !v.creditCards && !v.recentTransactions && !v.totals);
    check('Claude is told what was held back', v.hiddenByYou.includes('Credit cards'));
    check('the last four digits never appear', !JSON.stringify(v).includes('4242'));
    const open = privacy.financeForAi({ ...fin, settings: { ai: { cards: true } } });
    check('switching cards on shares them, still without the last four', open.creditCards.length === 1 && !JSON.stringify(open).includes('4242'));
  }

  console.log('\nCredit cards');
  {
    const data = { accounts: [], transactions: [], bills: [], budgets: [], goals: [], holdings: [], history: [], settings: {} };
    const today = new Date();
    const card = finance.upsert(data, 'accounts', {
      name: 'Freedom', type: 'credit', balance: 900, creditLimit: 3000, apr: 24, dueDay: 25, statementDay: 28,
      statementBalance: 600, minimumPayment: 35, autopay: 'minimum', last4: '4111111111111111',
    });
    check('only the last four of a card number are kept', card.last4 === '1111');
    const bill = data.bills.find((b) => b.cardId === card.id);
    check('a due day makes a payment bill for the statement balance', bill && bill.amount === 600 && bill.frequency === 'monthly');
    check('autopay carries over to the bill', bill.autopay === true);
    check('the card\'s bill cannot be edited on its own', throws(() => finance.upsert(data, 'bills', { id: bill.id, amount: 1 }), /belongs to a credit card/));
    check('or deleted on its own', throws(() => finance.remove(data, 'bills', bill.id), /belongs to a credit card/));

    const s = await finance.summary(data);
    const c = s.cards[0];
    check('utilisation is balance over limit', Math.round(c.utilization) === 30);
    check('available credit is shown', c.available === 2100);
    check('a month of interest at 24% APR on $900 is $18', c.monthlyInterestIfCarried === 18);

    const pay = finance.markPaid(data, bill.id, key(new Date(today.getFullYear(), today.getMonth(), 25)));
    check('paying the card is not logged as spending', pay.transaction === null && data.transactions.length === 0);
    check('it lowers the balance and the statement balance', data.accounts[0].balance === 300 && data.accounts[0].statementBalance === 0);
    finance.unmarkPaid(data, bill.id, pay.occurrence);
    check('undo puts both back', data.accounts[0].balance === 900 && data.accounts[0].statementBalance === 600);

    finance.upsert(data, 'accounts', { id: card.id, type: 'checking' });
    check('turning a card into another account removes its bill and card fields', !data.bills.some((b) => b.cardId) && data.accounts[0].apr === undefined);
    check('AI switches only take known keys', JSON.stringify(finance.setAiShare(data, { cards: true, bogus: true })).indexOf('bogus') === -1 && data.settings.ai.cards === true);
  }

  console.log('\nFiles read on this PC');
  {
    const csv = 'Transaction Date,Description,Amount,Category\n09/01/2026,"TRADER JOE\'S #123",-45.20,Groceries\n09/02/2026,PAYROLL,500.00,Income\n09/03/2026,"Coffee, large",-4.50,\n';
    const r = drops.fromCsv(csv);
    check('a bank CSV gives one transaction a row', r.items.length === 3);
    check('quoted commas and dates are read', r.items[2].title === 'Coffee, large' && r.items[0].date === '2026-09-01');
    check('the category comes along', r.items[0].notes === 'Groceries' && r.items[0].amount === -45.2);
    const debit = drops.fromCsv('Date,Description,Debit,Credit\n2026-09-05,Rent,800.00,\n2026-09-06,Refund,,20.00\n');
    check('Debit and Credit columns become signed amounts', debit.items[0].amount === -800 && debit.items[1].amount === 20);
    check('a CSV with no amount column is not guessed at', drops.fromCsv('Name,Email\nA,b@c.d\n') === null);
    check('(12.50) is negative', drops.parseMoney('(12.50)') === -12.5);

    const ofx = '<OFX><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260910120000<TRNAMT>-9.99<NAME>NETFLIX</STMTTRN><STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260911<TRNAMT>100.00<NAME>VENMO</STMTTRN></BANKTRANLIST></OFX>';
    const o = drops.fromOfx(ofx);
    check('OFX transactions are read', o.items.length === 2 && o.items[0].title === 'NETFLIX' && o.items[0].amount === -9.99 && o.items[1].date === '2026-09-11');

    // A minimal .docx: a zip holding word/document.xml, deflated.
    const xml = Buffer.from('<w:document><w:body><w:p><w:r><w:t>ECO 112 Midterm</w:t></w:r></w:p><w:p><w:r><w:t>October 14 &amp; 16</w:t></w:r></w:p></w:body></w:document>');
    const comp = zlib.deflateRawSync(xml);
    const name = Buffer.from('word/document.xml');
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(xml.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(xml.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
    const cdOffset = local.length + name.length + comp.length;
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(cdOffset, 16);
    const docx = Buffer.concat([local, name, comp, central, name, end]);
    check('a Word document\'s text is read, one line a paragraph', zip.docxText(docx) === 'ECO 112 Midterm\nOctober 14 & 16');
    check('something that is not a zip reads as nothing', zip.docxText(Buffer.from('hello')) === null);

    const mwf = drops.meetings({ date: '2026-09-07', repeats: 'weekly', weekdays: ['mon', 'wed', 'fri'], until: '2026-09-18' });
    check('a MWF class meets six times in two weeks', mwf.length === 6 && key(mwf[0]) === '2026-09-07' && key(mwf[5]) === '2026-09-18');
    check('a class with no end date stops after a term', drops.meetings({ date: '2026-09-07', repeats: 'weekly', weekdays: ['tue', 'thu'], until: null }).length <= 34);
    check('nothing before the first meeting', drops.meetings({ date: '2026-09-09', repeats: 'weekly', weekdays: ['mon', 'wed'], until: '2026-09-15' }).map(key).join() === '2026-09-09,2026-09-14');
  }

  console.log('\nThe assistant\'s reach');
  {
    const a = (p) => assistant.access(assistant.resolveApp(p).rel);
    check('sign-ins and keys are unreadable', !a('engine/google-tokens.json').read && !a('engine/ai-key.txt').read && !a('engine/client_secret_x.json').read);
    check('finance, captured mail and dropped files only through their tools', !a('engine/finance.json').read && !a('engine/auto-tasks.json').read && !a('engine/drops.json').read);
    check('history and its own settings are read-only', a('engine/history.json').read && !a('engine/history.json').write && !a('engine/ai.json').write);
    const canEnforce = claude.loadSettings().assistantCanEditEnforcement;
    check('blocking rules and its own guards are read-only by default', canEnforce || (!a('config.json').write && !a('engine/lib/ai/privacy.js').write && !a('engine/tasks.json').write));
    check('the dashboard and news code can be changed', a('engine/dashboard.html').write && a('engine/lib/news.js').write);
    check('nothing outside the Mellow folder', throws(() => assistant.resolveApp('../../Windows/win.ini'), /outside/));
    check('broken JavaScript is caught before it is offered', !!assistant.checkSyntax('x.js', 'function ('));
    check('broken JSON is caught', !!assistant.checkSyntax('x.json', '{"a":'));
    check('broken script in the dashboard is caught', !!assistant.checkSyntax('d.html', '<script>if (</script>'));

    const conv = { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'get_tasks', input: {} }] }] };
    assistant.pushUser(conv, [{ type: 'text', text: 'hello' }]);
    check('a tool call left hanging by an error is answered before the next message', conv.messages[1].content[0].type === 'tool_result' && conv.messages[1].content[0].tool_use_id === 't1');
    assistant.pushUser(conv, [{ type: 'text', text: 'again' }]);
    check('two messages in a row go into one turn', conv.messages.length === 2 && conv.messages[1].content.length === 3);
  }

  console.log('\nThe assistant, with Claude replaced by a script');
  {
    const tmpRel = 'engine/test-assistant-scratch.txt';
    const tmpAbs = path.join(__dirname, 'test-assistant-scratch.txt');
    fs.writeFileSync(tmpAbs, 'colour = blue\n');

    const script = [
      { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'u1', name: 'read_app_file', input: { path: tmpRel } }] },
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'u2', name: 'edit_app_file', input: { path: tmpRel, old_text: 'blue', new_text: 'green' } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Changed it to green.' }] },
    ];
    const seen = [];
    const realMessages = claude.messages;
    const realUnavailable = claude.unavailable;
    claude.unavailable = () => null;
    claude.messages = async (body) => { seen.push(JSON.parse(JSON.stringify(body.messages))); return { ...script.shift(), usd: 0, usage: {} }; };
    // A test's edit must not become the app's saved "Original".
    const versions = require('./lib/versions');
    const realEnsure = versions.ensureOriginal;
    versions.ensureOriginal = () => null;

    const ctx = { loopback: true, log: () => {}, state: () => ({}), calendar: async () => ({ days: [] }), news: async () => ({}) };
    let c = assistant.send({ text: 'Make it green', page: 'Today' }, ctx);
    await assistant.settle(c.id);
    c = assistant.publicConv(assistant.loadConv(c.id));
    check('reading runs by itself and the edit waits for approval', c.status === 'waiting' && c.pending.length === 1 && c.pending[0].codeChange);
    check('the approval shows the change as a diff', /- 1  colour = blue/.test(c.pending[0].diff) && /\+ 1  colour = green/.test(c.pending[0].diff));
    check('nothing is written before approval', fs.readFileSync(tmpAbs, 'utf8') === 'colour = blue\n');
    check('the file reached Claude with line numbers', JSON.stringify(seen[1]).includes('1\\tcolour = blue'));

    check('a phone cannot approve an app change', throws(() => assistant.decide({ id: c.id, all: true }, { ...ctx, loopback: false }), /only be approved on the PC/));
    assistant.decide({ id: c.id, all: true }, ctx);
    await assistant.settle(c.id);
    c = assistant.publicConv(assistant.loadConv(c.id));
    check('approving writes the file', fs.readFileSync(tmpAbs, 'utf8') === 'colour = green\n');
    check('and the conversation carries on to the answer', c.status === 'idle' && c.log.some((l) => l.text === 'Changed it to green.'));
    const change = c.log.find((l) => l.role === 'change' && l.changeId);
    check('the change can be undone', !!change);
    assistant.undoChange(change.changeId, ctx);
    check('undo puts the file back', fs.readFileSync(tmpAbs, 'utf8') === 'colour = blue\n');
    check('and cannot be done twice', throws(() => assistant.undoChange(change.changeId, ctx), /already undone/));
    const sent = seen[2];
    check('Claude was told the change was applied', JSON.stringify(sent[sent.length - 1]).includes(`Changed ${tmpRel}`));

    // A request for a guarded file is refused without asking anyone.
    script.push(
      { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'u3', name: 'read_app_file', input: { path: 'engine/google-tokens.json' } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I cannot read that.' }] },
    );
    assistant.send({ id: c.id, text: 'Show me the tokens' }, ctx);
    await assistant.settle(c.id);
    const after = assistant.loadConv(c.id);
    const lastResult = JSON.stringify(after.messages[after.messages.length - 2]);
    check('a secret file is refused, and no approval is asked for', !after.pending && /holds a sign-in or key/.test(lastResult));

    claude.messages = realMessages;
    claude.unavailable = realUnavailable;
    versions.ensureOriginal = realEnsure;
    assistant.deleteConv(c.id);
    fs.unlinkSync(tmpAbs);
    try { fs.rmSync(path.join(assistant.BACKUP_DIR, change.changeId), { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\nNews subscriptions');
  {
    check('a renewal email counts as a subscription email', news.SUBSCRIPTION_SUBJECT.test('Your WSJ subscription will renew soon'));
    check('a newsletter does not', !news.SUBSCRIPTION_SUBJECT.test('The 10-Point: What to know today'));
    check('the Journal is in the catalogue', news.CATALOG.some((c) => c.id === 'wsj' && c.mail.includes('wsj.com')));
    const papers = [{ id: 'nyt', name: 'NYT', items: [], outlets: [] }, { id: 'wsj', name: 'WSJ', items: [{ title: 'Fed Raises Rates Again as Inflation Persists', link: 'https://wsj.com/a' }], outlets: [], subscribed: true }];
    const links = news.readingLinks({ title: 'Fed raises rates again, inflation persists', related: [] }, papers);
    check('a link from a paper you subscribe to is marked as yours', links[0].subscribed === true);
  }

  console.log('\nWithout a key');
  {
    const had = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    if (!fs.existsSync(claude.KEY_FILE)) {
      check('AI says what is missing instead of failing', /API key/.test(claude.unavailable() || ''));
      await claude.messages({}).then(() => check('no request is made', false), (e) => check('no request is made', e.code === 'unavailable'));
    } else {
      console.log('  (skipped: a key is configured on this PC)');
    }
    if (had) process.env.ANTHROPIC_API_KEY = had;
    check('a key that is not an Anthropic key is refused', throws(() => claude.saveKey('hunter2'), /sk-ant-/));
    check('pricing counts cache reads at a tenth', Math.abs(claude.priceOf('claude-opus-5', { cache_read_input_tokens: 1e6 }) - 0.5) < 1e-9);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
