'use strict';
/**
 * test-files.js - the Files library: folders, filing a scan, spotting what is
 * already on the calendar, and keeping files until you remove them. Claude is
 * replaced with a script and everything is written to a temporary folder, so
 * this runs offline and never touches your own files.
 *
 *   node test-files.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-files-'));
process.env.RATCHET_DATA_DIR = TMP;

const drops = require('./lib/drops');
const claude = require('./lib/ai/claude');
const dedupe = require('./lib/dedupe');
const autotasks = require('./lib/autotasks');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scanned(id) {
  for (let i = 0; i < 100; i++) {
    const d = drops.getDrop(id);
    if (d && d.status !== 'scanning') return d;
    await sleep(20);
  }
  return drops.getDrop(id);
}

(async () => {
  const realMessages = claude.messages;
  const realUnavailable = claude.unavailable;
  try {
    console.log('\nThe same thing, named twice');
    {
      check('a course code in front still matches', drops.sameThing('Problem Set 3', 'ECO 112 Problem Set 3'));
      check('word order and punctuation do not matter', drops.sameThing('Midterm exam, ECO 112', 'ECO 112 — Midterm Exam'));
      check('different assignments do not match', !drops.sameThing('Problem Set 3', 'Problem Set 4'));
      check('one shared word is not enough', !drops.sameThing('Chemistry lab report', 'Lab safety training'));
      check('empty titles never match', !drops.sameThing('', 'Anything'));
      check('sharing only a course code is not a match', !drops.sameThing('ECO 112 Lecture', 'ECO 112 Homework 1'));
      check('a course code written without a space still matches', drops.sameThing('ECO112 — Homework 1', 'Homework 1 DUE'));
      check('a class meeting matches its own calendar entry', drops.sameThing('ECO 112 Lecture', 'Lecture: ECO 112'));
    }

    console.log('\nAlready on your calendar');
    {
      const drop = {
        id: 'x', items: [
          { id: 'a', kind: 'exam', title: 'Midterm', course: 'ECO 112', date: '2026-10-08' },
          { id: 'b', kind: 'deadline', title: 'Problem Set 3', course: 'ECO 112', date: '2026-10-01' },
          { id: 'c', kind: 'event', title: 'Guest lecture', date: '2026-10-02' },
          { id: 'd', kind: 'bill', title: 'Phone bill', date: '2026-10-15' },
          { id: 'e', kind: 'exam', title: 'Midterm', course: 'ECO 112', date: '2026-10-09', added: true },
        ],
      };
      const existing = {
        schedule: [
          { title: 'ECO 112 Midterm', day: '2026-10-08', kind: 'event' },
          { title: 'ECO 112 Problem Set 3', day: '2026-10-01', kind: 'deadline' },
          { title: 'Guest lecture', day: '2026-10-03', kind: 'event' },
        ],
        bills: ['Phone Bill'],
      };
      const m = drops.markExisting(drop, existing);
      const by = Object.fromEntries(m.items.map((x) => [x.id, x]));
      check('an exam already on the calendar that day is marked', by.a.existing === 'calendar');
      check('a deadline already captured is marked as a deadline', by.b.existing === 'deadline');
      check('the same title on a different day is not', !by.c.existing);
      check('a bill with the same name is marked', by.d.existing === 'finance');
      check('something you already added is left alone', !by.e.existing);
      check('the file itself is not changed', !drop.items[0].existing);
      const span = drops.itemSpan([drop]);
      check('only the days the suggestions fall on are checked', span && span.from.getDate() === 1 && span.to.getDate() === 15);
      check('a file with nothing dated asks for no range', drops.itemSpan([{ items: [{ kind: 'task', date: null }] }]) === null);
    }

    console.log('\nHomework captured twice');
    {
      const dash = String.fromCharCode(0xe2, 0x20ac, 0x201d); // an em dash saved with the wrong encoding
      const cal = (ref) => ({ type: 'calendar', ref, from: 'Class' });
      const hw = (key, title, course, dueAt, extra) => ({ key, title, course, kind: 'homework', dueAt, hasTime: true, dueFrom: cal(key), sources: [cal(key)], confirmed: false, dismissed: false, ...extra });
      const state = { homework: {} };
      const add = (h) => { state.homework[h.key] = h; };
      add(hw('hw:eco112:eco112 homework 1', `ECO112 ${dash} Homework 1`, 'ECO112', '2026-09-16T03:59:00.000Z', { confirmed: true }));
      add(hw('hw:eco 112:homework 1', 'Homework 1', 'ECO 112', '2026-09-16T03:59:00.000Z'));
      add(hw('file:abc:1', 'Homework 1 due', 'ECO 112', '2026-09-16T03:59:00.000Z', { dueFrom: { type: 'file', ref: 'abc' }, sources: [{ type: 'file', ref: 'abc' }] }));
      add(hw('hw:eco 112:homework 2', 'Homework 2', 'ECO 112', '2026-09-16T03:59:00.000Z'));
      add(hw('hw:dan 119:quiz', 'Quiz: Bronx is Burning', 'DAN 119', '2026-09-15T03:59:00.000Z', { confirmed: true }));
      add(hw('hw::dan 119 1 quiz', 'DAN-119-1/AFR-119-1/CRE-119-1-202690: QUIZ - Bronx is Burning', '', '2026-09-15T03:59:00.000Z'));
      add(hw('hw:intl:exam 1', 'In-Class Exam #1', 'Intl Politics', '2026-10-07T18:45:00.000Z', { kind: 'exam' }));
      add(hw('hw::intl exam 1', `Intl Politics ${dash} IN-CLASS EXAM #1`, '', '2026-10-07T18:45:00.000Z', { kind: 'exam', confirmed: true }));
      add(hw('file:gov:exam1', 'In-Class Exam #1', 'GOV 113', '2026-10-08T03:59:00.000Z', { kind: 'exam', dueFrom: { type: 'file', ref: 'gov' }, sources: [] }));
      add(hw('hw:eco 112:midterm', 'Midterm I', 'ECO 112', '2026-10-08T17:15:00.000Z', { kind: 'exam' }));
      add(hw('hw:eco 112:hw midterm', 'Midterm I reflection', 'ECO 112', '2026-10-09T17:15:00.000Z'));
      add(hw('hw:gone', 'Homework 1', 'ECO 112', '2026-09-16T03:59:00.000Z', { dismissed: true }));

      const r = dedupe.dedupeHomework(state, new Set(['hw::dan 119 1 quiz']));
      const live = Object.values(state.homework).filter((h) => !h.dismissed);
      const eco1 = live.filter((h) => /homework 1/i.test(h.title));
      check('three copies of Homework 1 become one', eco1.length === 1);
      check('the one you confirmed is the one kept', eco1[0].key === 'hw:eco112:eco112 homework 1' && eco1[0].confirmed);
      check('it takes the cleanest title and course', eco1[0].title === 'Homework 1' && eco1[0].course === 'ECO 112');
      check('the others point at it and are not deleted', state.homework['file:abc:1'].mergedInto === eco1[0].key && state.homework['hw:eco 112:homework 1'].mergedInto === eco1[0].key);
      check('it keeps every source', eco1[0].sources.length === 3);
      check('Homework 2 on the same day is left alone', !state.homework['hw:eco 112:homework 2'].dismissed);
      const quiz = live.filter((h) => /bronx/i.test(h.title));
      check('a quiz named two ways becomes one', quiz.length === 1);
      check('the copy you marked done is the one kept, so it stays done', quiz[0].key === 'hw::dan 119 1 quiz' && quiz[0].confirmed && quiz[0].title === 'Quiz: Bronx is Burning');
      check('an exam with and without its course name becomes one', live.filter((h) => h.kind === 'exam' && /exam #1/i.test(h.title) && h.course !== 'GOV 113').length === 1);
      check('the same exam name for a different class is kept apart', !state.homework['file:gov:exam1'].dismissed);
      check('an exam and homework on different days are kept apart', !state.homework['hw:eco 112:midterm'].dismissed && !state.homework['hw:eco 112:hw midterm'].dismissed);
      check('something you dismissed stays dismissed, not merged', !state.homework['hw:gone'].mergedInto);
      check('mangled dashes are repaired', !live.some((h) => h.title.includes(dash)));
      check('it reports what it did', r.merged === 4);
      check('running it again changes nothing', dedupe.dedupeHomework(state, new Set()).merged === 0);

      // The next sync still reads the calendar entry under the key that was set aside.
      autotasks.mergeHomework(state, [{ key: 'hw:eco 112:homework 1', kind: 'homework', title: 'Homework 1', course: 'ECO 112', dueAt: new Date('2026-09-17T03:59:00.000Z'), hasTime: true, source: { type: 'calendar', ref: 'hw:eco 112:homework 1', from: 'Class' } }], new Date('2026-09-14T12:00:00Z'));
      check('a date that moves on a merged copy moves the one kept', state.homework['hw:eco112:eco112 homework 1'].dueAt === '2026-09-17T03:59:00.000Z');
      check('and the merged copy stays set aside', state.homework['hw:eco 112:homework 1'].dismissed);

      const lecture = { title: 'ECO 112 — Introductory Microeconomics lecture', start: '2026-09-15T17:15:00.000Z', allDay: false };
      const google = [{ title: 'ECO112 — Price Controls and Quotas', start: '2026-09-15T17:15:00.000Z', allDay: false }, { title: 'GOV 113 — Class', start: '2026-09-15T19:00:00.000Z', allDay: false }];
      check('a syllabus lecture your Google calendar already has is covered', !!dedupe.coveredBy(lecture, google));
      check('office hours at another time are not', !dedupe.coveredBy({ ...lecture, title: 'ECO 112 — Office Hours', start: '2026-09-15T20:00:00.000Z' }, google));
      check('another class at the same time is not', !dedupe.coveredBy({ ...lecture, title: 'DAN 119 — Performing Hip Hop Culture' }, google));

      const classDrop = drops.markExisting({ items: [{ id: 'c', kind: 'class', title: 'Lecture', course: 'ECO 112', date: '2026-09-15', startTime: '13:15' }] },
        { schedule: [{ title: 'ECO112 — Price Controls and Quotas', day: '2026-09-15', kind: 'event', minutes: 13 * 60 + 15 }], bills: [] });
      check('Files says a class is already on your calendar when the same class is there at that time', classDrop.items[0].existing === 'calendar');
    }

    console.log('\nFolders');
    {
      const names = drops.allFolders().map((f) => f.name);
      check('the built-in folders are there from the start', ['Syllabus', 'School', 'Work', 'Notes', 'Finance', 'Personal', 'Other'].every((n) => names.includes(n)));
      const f = drops.createFolder('  Chipotle   shifts ');
      check('a new folder is tidied and kept', f.name === 'Chipotle shifts' && f.custom && drops.allFolders().some((x) => x.id === f.id));
      check('making it again returns the same folder', drops.createFolder('chipotle shifts').id === f.id);
      check('a folder needs a name', throws(() => drops.createFolder('   '), /name/));
      check('markup is stripped from a name', drops.createFolder('<b>Lab</b>').name === 'bLab/b'.replace('/', ''));
      check('the built-in folders cannot be removed', throws(() => drops.deleteFolder('school'), /stay/));
      check('the scan is offered your folders too', JSON.stringify(drops.schemaFor(drops.allFolders().map((x) => x.id))).includes(f.id));
    }

    console.log('\nFiling a scan');
    {
      claude.unavailable = () => null;
      let asked = null;
      claude.messages = async (body) => {
        asked = body;
        return {
          usd: 0.01, usage: {}, stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify({
            title: 'ECO 112 Syllabus, Fall 2026', folder: 'syllabus', summary: 'The syllabus for ECO 112.',
            highlights: ['Office hours Tue 2-4', 'Pay the lab fee with card 4111 1111 1111 1111'], documentKind: 'syllabus',
            items: [{ kind: 'exam', title: 'Midterm', course: 'ECO 112', date: '2026-10-08', startTime: '10:00', endTime: null, location: null, amount: null, repeats: 'none', weekdays: [], until: null, notes: null, evidence: 'Midterm Oct 8', confidence: 'high', card: null }],
          }) }],
        };
      };
      const d0 = drops.intake({ name: 'syllabus.txt', data: Buffer.from('ECO 112 syllabus. Midterm Oct 8.').toString('base64'), section: 'today' });
      const d = await scanned(d0.id);
      check('the scan finishes', d.status === 'ready');
      check('it gets a readable title', d.title === 'ECO 112 Syllabus, Fall 2026');
      check('it is filed where Claude said', d.folder === 'syllabus' && d.folderBy === 'ai');
      check('key facts are kept', d.highlights.length === 2 && d.highlights[0] === 'Office hours Tue 2-4');
      check('a card number in a key fact is masked', !d.highlights.join(' ').includes('4111 1111') && d.highlights[1].includes('1111'));
      check('what could be added is listed, nothing added', d.items.length === 1 && !d.items[0].added);
      check('Claude is told which folders exist', JSON.stringify(asked.messages).includes('syllabus:') && JSON.stringify(asked.output_config).includes('"folder"'));

      const moved = drops.moveDrop(d.id, 'school');
      check('you can move a file', moved.folder === 'school' && moved.folderBy === 'you');
      check('not to a folder that does not exist', throws(() => drops.moveDrop(d.id, 'nope'), /no folder/));
      await drops.scan(d.id);
      check('a rescan keeps it where you put it', drops.getDrop(d.id).folder === 'school');

      claude.messages = async () => ({ usd: 0, usage: {}, stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ title: 'x', folder: 'made-up', summary: '', highlights: [], documentKind: 'other', items: [] }) }] });
      const odd = await scanned(drops.intake({ name: 'odd.txt', data: Buffer.from('hello').toString('base64'), section: 'today' }).id);
      check('a folder Claude invents lands in Other', odd.folder === 'other');

      const csv = await scanned(drops.intake({ name: 'checking.csv', data: Buffer.from('Date,Description,Amount\n2026-09-01,Coffee,-4.50\n').toString('base64'), section: 'today' }).id);
      check('a bank export is read here and filed in Finance', csv.method === 'local' && csv.folder === 'finance' && csv.title === 'checking');

      const f = drops.allFolders().find((x) => x.name === 'Chipotle shifts');
      drops.moveDrop(odd.id, f.id);
      check('removing a folder you made moves its files to Other', drops.deleteFolder(f.id).moved === 1 && drops.getDrop(odd.id).folder === 'other');

      const raw = drops.rawFile(d.id);
      check('the original file can be opened, from inside the files folder only', raw && path.dirname(raw.file) === drops.DIR && raw.name === 'syllabus.txt');
      check('an unknown id opens nothing', drops.rawFile('../../engine-config') === null);
    }

    console.log('\nKept until you remove them');
    {
      const index = JSON.parse(fs.readFileSync(drops.INDEX, 'utf8'));
      const extra = Array.from({ length: 120 }, (_, i) => ({ id: `old${i}`, name: `old${i}.txt`, ext: '.txt', status: 'ready', items: [], documentKind: i % 2 ? 'syllabus' : 'bill' }));
      fs.writeFileSync(drops.INDEX, JSON.stringify({ ...index, drops: [...index.drops, ...extra] }));
      drops.createFolder('Trigger a save');
      check('more than a hundred files are all kept', drops.list().length >= 123);
      const legacy = drops.list().filter((x) => /^old/.test(x.id));
      check('files from before folders are filed by what they were', legacy.some((x) => x.folder === 'syllabus') && legacy.some((x) => x.folder === 'finance'));
    }

    console.log('\nBank and brokerage exports');
    {
      const bank = [
        'Account Number,Post Date,Check,Description,Debit,Credit,Status,Classification',
        '"XXXXXX9600",9/14/2026,9999,"ANTHROPIC",21.32,,Pending,""',
        '"XXXXXX9600",9/14/2026,,"Anthropic",10.72,,Posted,"Electronics &amp; Software"',
        '"XXXXXX9600",9/14/2026,,"Funds Transfer",,200.00,Posted,"Transfer"',
        '"XXXXXX9600",8/31/2026,,"Interest Income",,.26,Posted,"Interest Income"',
      ].join('\r\n');
      const r = drops.fromCsv(bank);
      check('debits are spending and credits come in', r.items.length === 4 && r.items[1].amount === -10.72 && r.items[2].amount === 200 && r.items[3].amount === 0.26);
      check('a Classification column is the category, with &amp; read as &', r.items[1].notes === 'Electronics & Software');
      check('a pending row is marked pending', r.items[0].pending === true && !r.items[1].pending);
      check('the account is kept as its last four digits only', r.account && r.account.last4 === '9600');
      check('the description is not taken from the account number', r.items[0].title === 'ANTHROPIC');

      const etrade = [
        'Account Summary',
        'Account,Net Account Value,Total Gain $,Total Gain %',
        'E*TRADE Individual Brokerage -1234,1500.00,100.00,7.1',
        'View Summary - All Positions',
        'Symbol,Last Price $,Change $,Change %,Quantity,Price Paid $,Day\'s Gain $,Total Gain $,Total Gain %,Value $',
        'NKE,80.00,1.00,1.2,10,70.00,10.00,100.00,14.2,800.00',
        'BRK.B,450.00,2.00,0.4,1,400.00,2.00,50.00,12.5,450.00',
        'AAPL Jan 16 \'27 $200 Call,5.00,0,0,1,3.00,0,200,66,500.00',
        'CASH,,,,,,,,,250.00',
        'TOTAL,,,,,,,,,1500.00',
      ].join('\n');
      const h = drops.fromCsv(etrade);
      check('an E*TRADE positions file is read as holdings', h && h.items.length === 2 && h.items.every((x) => x.kind === 'holding'));
      check('price paid per share becomes the total paid', h.items[0].title === 'NKE' && h.items[0].amount === 10 && h.items[0].costBasis === 700);
      check('a class-B share is written the way prices are looked up', h.items[1].title === 'BRK-B');
      check('the cash line is the account\'s cash, and the account is E*TRADE', h.holdings.cash === 250 && h.holdings.account === 'E*TRADE');
      check('an option it cannot price is skipped and said so', /Skipped AAPL/.test(h.summary));

      const coinbase = [
        'Transactions',
        'User,Campbell,abc',
        'ID,Timestamp,Transaction Type,Asset,Quantity Transacted,Price Currency,Price at Transaction,Subtotal,Total (inclusive of fees and/or spread),Fees and/or Spread,Notes',
        '1,2026-01-27 10:00:00 UTC,Buy,BTC,0.005,USD,$90000.00,$450.00,$460.00,$10.00,Bought 0.005 BTC',
        '2,2026-04-30 10:00:00 UTC,Buy,SOL,2,USD,$95.00,$190.00,$200.00,$10.00,Bought 2 SOL',
        '3,2026-05-01 10:00:00 UTC,Send,SOL,0.5,USD,$95.00,,,,Sent to wallet',
        '4,2026-06-01 10:00:00 UTC,Convert,BTC,0.001,USD,$90000.00,$90.00,$90.00,$0.00,Converted 0.001 BTC to 90.00 USDC',
        '5,2026-06-02 10:00:00 UTC,Staking Income,SOL,0.01,USD,$95.00,$0.95,$0.95,$0.00,',
      ].join('\n');
      const c = drops.fromCsv(coinbase);
      const by = Object.fromEntries(c.items.map((x) => [x.title, x]));
      check('a Coinbase report is added up per coin', c.holdings.account === 'Coinbase' && by['BTC-USD'].amount === 0.004 && by['SOL-USD'].amount === 1.51);
      check('a convert moves the coin across, with what it cost', by['USDC-USD'].amount === 90 && by['USDC-USD'].costBasis === 92);
      check('what is left of a buy keeps its share of the cost', by['BTC-USD'].costBasis === 368);
    }
  } finally {
    claude.messages = realMessages;
    claude.unavailable = realUnavailable;
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
