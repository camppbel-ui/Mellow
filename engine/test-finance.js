'use strict';
/**
 * test-finance.js - the Finance page's arithmetic: items in, totals and due
 * dates out. Everything runs on an in-memory copy, so finance.json is never
 * touched and nothing goes to the network.
 *
 *   node test-finance.js
 */

const finance = require('./lib/finance');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}
function throws(fn, re) {
  try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; }
}

const pad = (n) => String(n).padStart(2, '0');
const key = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const empty = () => ({ accounts: [], transactions: [], bills: [], budgets: [], goals: [], holdings: [], history: [], settings: {} });

console.log('\nItems');
{
  const data = empty();
  const a = finance.upsert(data, 'accounts', { name: 'Checking', type: 'checking', balance: '$1,250.50' });
  check('a new account gets an id', /^[0-9a-f]{12}$/.test(a.id));
  check('money typed with $ and commas is read as a number', a.balance === 1250.5);
  check('the balance is dated', !!a.updatedAt);
  check('an unknown type falls back to checking', finance.upsert(data, 'accounts', { name: 'X', type: 'bitcoin wallet', balance: 1 }).type === 'checking');
  check('a missing balance is refused with the field named', throws(() => finance.upsert(data, 'accounts', { name: 'Y' }), /^Balance: required/));
  check('punctuation in a name survives', finance.upsert(data, 'accounts', { name: "Mom & Dad's (529)", balance: 1 }).name === "Mom & Dad's (529)");

  const b = finance.upsert(data, 'accounts', { id: a.id, balance: 900 });
  check('a partial update keeps the other fields', b.name === 'Checking' && b.balance === 900);
  check('and replaces the item in place', data.accounts.length === 3 && data.accounts[0].balance === 900);
  check('an id that is gone is refused', throws(() => finance.upsert(data, 'accounts', { id: 'nope', balance: 1 }), /no longer there/));
  check('a bad date is refused', throws(() => finance.upsert(data, 'transactions', { date: '2026-02-30', description: 'x', amount: 1 }), /Date: not a date/));
  check('a bad ticker is refused', throws(() => finance.upsert(data, 'holdings', { symbol: 'NKE; rm', shares: 1 }), /ticker/));
  check('tickers are upper-cased', finance.upsert(data, 'holdings', { symbol: 'nke', shares: 2 }).symbol === 'NKE');

  finance.upsert(data, 'budgets', { category: 'Food', monthly: 300 });
  check('two budgets for the same category are refused', throws(() => finance.upsert(data, 'budgets', { category: 'food', monthly: 1 }), /already a budget/));

  const h = data.holdings[0];
  finance.upsert(data, 'holdings', { symbol: 'LULU', shares: 1, accountId: a.id });
  finance.remove(data, 'accounts', a.id);
  check('removing an account unlinks its holdings', data.holdings.every((x) => x.accountId !== a.id));
  check('removing something already gone is refused', throws(() => finance.remove(data, 'accounts', a.id)));
  check('the untouched holding is still there', data.holdings.includes(h));
}

console.log('\nBills');
{
  const occ = (bill, from, to) => finance.occurrences(bill, new Date(from), new Date(to)).map(key);
  check('monthly on the 15th', occ({ dueDate: '2026-01-15', frequency: 'monthly' }, '2026-03-01T00:00', '2026-05-31T00:00').join() === '2026-03-15,2026-04-15,2026-05-15');
  check('the 31st falls on the last day of a short month', occ({ dueDate: '2026-01-31', frequency: 'monthly' }, '2026-02-01T00:00', '2026-04-30T00:00').join() === '2026-02-28,2026-03-31,2026-04-30');
  check('nothing before the first due date', occ({ dueDate: '2026-06-10', frequency: 'monthly' }, '2026-04-01T00:00', '2026-07-31T00:00').join() === '2026-06-10,2026-07-10');
  check('every two weeks from the anchor', occ({ dueDate: '2026-09-04', frequency: 'biweekly' }, '2026-09-10T00:00', '2026-10-10T00:00').join() === '2026-09-18,2026-10-02');
  check('weekly', occ({ dueDate: '2026-01-02', frequency: 'weekly' }, '2026-09-01T00:00', '2026-09-14T00:00').join() === '2026-09-04,2026-09-11');
  check('yearly', occ({ dueDate: '2025-03-01', frequency: 'yearly' }, '2026-01-01T00:00', '2027-12-31T00:00').join() === '2026-03-01,2027-03-01');
  check('once is once', occ({ dueDate: '2026-09-20', frequency: 'once' }, '2026-01-01T00:00', '2027-12-31T00:00').join() === '2026-09-20');

  check('a yearly bill is a twelfth of itself per month', finance.monthlyEquivalent({ amount: 1200, frequency: 'yearly' }) === 100);
  check('a weekly one is 52 twelfths', Math.abs(finance.monthlyEquivalent({ amount: 12, frequency: 'weekly' }) - 52) < 1e-9);

  const today = new Date();
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, Math.min(today.getDate(), 28));
  const data = empty();
  const rent = finance.upsert(data, 'bills', { name: 'Rent', amount: 800, dueDate: key(lastMonth), frequency: 'monthly', category: 'Rent' });
  check('a new bill starts with nothing paid', Array.isArray(rent.paid) && rent.paid.length === 0);

  const r = finance.markPaid(data, rent.id);
  check('paying marks the oldest open one first', r.occurrence === key(lastMonth));
  check('and logs it as spending', data.transactions.length === 1 && data.transactions[0].amount === -800 && data.transactions[0].category === 'Rent');
  const r2 = finance.markPaid(data, rent.id);
  check('paying again moves on to the next one', r2.occurrence > r.occurrence);
  finance.unmarkPaid(data, rent.id, r2.occurrence);
  check('taking it back removes that payment and only that one', !data.bills[0].paid.includes(r2.occurrence) && data.transactions.length === 1);
  finance.markPaid(data, rent.id, null, { log: false });
  check('paying without logging adds no transaction', data.transactions.length === 1);

  const pay = finance.upsert(data, 'bills', { name: 'Job', amount: 400, dueDate: key(today), frequency: 'biweekly', income: 'true' });
  finance.markPaid(data, pay.id);
  check('a payday received is logged as income', data.transactions.some((t) => t.description === 'Job' && t.amount === 400));
}

(async () => {
  console.log('\nTotals');
  {
    const data = empty();
    const brokerage = finance.upsert(data, 'accounts', { name: 'Brokerage', type: 'investment', balance: 50 });
    finance.upsert(data, 'accounts', { name: 'Checking', type: 'checking', balance: 1000 });
    finance.upsert(data, 'accounts', { name: 'Card', type: 'credit', balance: 250 });
    finance.upsert(data, 'accounts', { name: 'Loan', type: 'loan', balance: -5000 });
    const holdings = [
      { symbol: 'AAA', shares: 2, value: 200, accountId: brokerage.id },
      { symbol: 'BBB', shares: 1, value: 30, accountId: '' },
      { symbol: 'CCC', shares: 1, value: null, accountId: '' },
    ];
    const t = finance.totals(data, holdings);
    check('shares in an account are added to its cash', t.accounts[0].value === 250);
    check('shares in no account still count', t.invested === 280);
    check('a holding with no price counts for nothing rather than breaking', Number.isFinite(t.netWorth));
    check('debt counts whether typed as owed or as negative', t.debt === 5250);
    check('net worth is what you have less what you owe', t.netWorth === 1000 + 280 - 5250);
  }

  console.log('\nSummary');
  {
    const data = empty();
    const now = new Date();
    const d = (n) => key(new Date(now.getFullYear(), now.getMonth(), n));
    finance.upsert(data, 'budgets', { category: 'Food', monthly: 100 });
    finance.upsert(data, 'budgets', { category: 'Fun', monthly: 50 });
    finance.upsert(data, 'transactions', { date: d(1), description: 'Groceries', amount: -60, category: 'food' });
    finance.upsert(data, 'transactions', { date: d(1), description: 'More', amount: -55, category: 'Food' });
    finance.upsert(data, 'transactions', { date: d(1), description: 'Paycheck', amount: 500, category: 'Income' });
    finance.upsert(data, 'goals', { name: 'Trip', target: 1000, saved: 250 });
    finance.upsert(data, 'bills', { name: 'Phone', amount: 40, dueDate: key(now), frequency: 'monthly' });
    finance.upsert(data, 'bills', { name: 'Gym', amount: 20, dueDate: key(new Date(now.getTime() - 3 * 86400000)), frequency: 'once' });
    finance.upsert(data, 'bills', { name: 'Stream', amount: 10, dueDate: key(new Date(now.getTime() - 3 * 86400000)), frequency: 'once', autopay: true });

    const s = await finance.summary(data);
    const food = s.budgets.find((b) => b.category === 'Food');
    check('spending matches a budget whatever the capitals', food.spent === 115);
    check('and is over it', food.status === 'over' && food.left === -15);
    check('income is not spending', s.month.spent === 115 && s.month.income === 500);
    check('the goal is a quarter done', s.goals[0].percent === 25 && s.goals[0].left === 750);
    check('a bill due today is in this week', s.upcoming.some((u) => u.name === 'Phone' && u.daysAway === 0) && s.dueThisWeek.count >= 1);
    check('an unpaid bill from three days ago is overdue', s.overdue.some((u) => u.name === 'Gym'));
    check('an autopay bill that has passed is not', !s.upcoming.some((u) => u.name === 'Stream'));
  }

  console.log('\nImporting from a bank');
  {
    const data = empty();
    const now = new Date();
    const day = (n) => key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
    const rows = [
      { date: day(0), description: 'ANTHROPIC', amount: -21.32, pending: true },
      { date: day(1), description: 'Kindle', amount: -14.74, category: 'Books' },
      { date: day(1), description: 'Kindle', amount: -14.74, category: 'Books' },
      { date: day(2), description: 'Coinbase', amount: -100, category: 'Transfer' },
      { date: day(3), description: 'Transfer to Venmo', amount: -20, category: 'Transfer' },
      { date: day(4), description: 'Sign Debit Oasis', amount: -7.49, category: 'Shopping' },
      { date: 'not a date', description: 'Broken', amount: -1 },
    ];
    const r = finance.importTransactions(data, rows, { account: { last4: 'XXXXXX9600' } });
    check('every good row is added', r.added === 6 && r.results[6].status === 'error');
    check('two identical purchases on one day stay two', data.transactions.filter((t) => t.description === 'Kindle').length === 2);
    check('the account the export came from is made, with only its last four digits', r.account && r.account.name === 'Checking ••9600' && data.accounts[0].detected.last4 === '9600' && !JSON.stringify(data).includes('XXXXXX'));
    check('and has no balance until you enter one', data.accounts[0].balance === null);
    check('money sent to Coinbase makes a Coinbase account', data.accounts.some((a) => a.name === 'Coinbase' && a.type === 'investment'));
    check('and Venmo too', data.accounts.some((a) => a.name === 'Venmo'));
    check('the new accounts are reported', r.detected.includes('Coinbase') && r.detected.includes('Checking ••9600'));

    const again = finance.importTransactions(data, rows.slice(0, 6), { account: { last4: '9600' } });
    check('the same export twice adds nothing', again.added === 0 && again.duplicates === 6 && data.transactions.length === 6);
    check('and makes no second account', data.accounts.filter((a) => a.name === 'Coinbase').length === 1 && data.accounts.filter((a) => /9600/.test(a.name)).length === 1);

    const posted = finance.importTransactions(data, [{ date: day(0), description: 'Anthropic', amount: -21.32 }]);
    check('a pending charge that has posted replaces itself', posted.settled === 1 && posted.added === 0 && !data.transactions.some((t) => t.pending));

    const s = await finance.summary(data);
    const coinbase = data.accounts.find((a) => a.name === 'Coinbase');
    check('money into an investment account is not spending', data.transactions.find((t) => t.description === 'Coinbase').transferAccountId === coinbase.id);
    check('money sent to Venmo still is', !data.transactions.find((t) => /venmo/i.test(t.description)).transferAccountId);
    check('an account with no balance counts for nothing in net worth', s.netWorth === 0 && s.accounts.every((a) => a.balanceMissing));

    finance.remove(data, 'accounts', coinbase.id);
    finance.detectAccounts(data);
    check('an account you delete is not found again', !data.accounts.some((a) => a.name === 'Coinbase'));
    check('and its transfers count as spending again', !data.transactions.find((t) => t.description === 'Coinbase').transferAccountId);

    const old = empty();
    finance.importTransactions(old, [{ date: '2023-01-05', description: 'Transfer from Cash App', amount: 10 }]);
    check('an app last used years ago is not made into an account', !old.accounts.length);

    check('a bill paid by hand is not added again when the bank shows it', (() => {
      const d2 = empty();
      const bill = finance.upsert(d2, 'bills', { name: 'Rent', amount: 800, dueDate: day(2), frequency: 'monthly' });
      finance.markPaid(d2, bill.id);
      const res = finance.importTransactions(d2, [{ date: day(1), description: 'Zelle Landlord', amount: -800 }]);
      return res.added === 0 && d2.transactions.length === 1;
    })());
  }

  console.log('\nAccounts from email');
  {
    const data = empty();
    check('a trade confirmation from E*TRADE makes the account', !!finance.detectFromEmail(data, { fromAddress: 'noreply@etrade.com', subject: 'Your order has been executed', labels: [] }));
    check('an advert from Robinhood does not', !finance.detectFromEmail(data, { fromAddress: 'news@robinhood.com', subject: 'Invest in 2027', labels: [] }));
    check('nor anything filed under promotions', !finance.detectFromEmail(data, { fromAddress: 'hello@coinbase.com', subject: 'Your account statement', labels: ['CATEGORY_PROMOTIONS'] }));
    check('an account already there is not made twice', !finance.detectFromEmail(data, { fromAddress: 'alerts@etrade.com', subject: 'Deposit received', labels: [] }));
  }

  console.log('\nHoldings');
  {
    const data = empty();
    const r = finance.importHoldings(data, [{ symbol: 'NKE', shares: 3, costBasis: 240 }, { symbol: 'BTC-USD', shares: 0.00123456, costBasis: 80 }], { account: 'E*TRADE', cash: 12.5 });
    check('a positions file makes its account, with the cash as its balance', r.account.created && data.accounts[0].name === 'E*TRADE' && data.accounts[0].balance === 12.5);
    check('a sliver of a bitcoin is kept to eight places', data.holdings.find((h) => h.symbol === 'BTC-USD').shares === 0.00123456);
    finance.importHoldings(data, [{ symbol: 'NKE', shares: 5, costBasis: 400 }], { account: 'E*TRADE' });
    check('a newer file updates a position rather than adding it twice', data.holdings.filter((h) => h.symbol === 'NKE').length === 1 && data.holdings[0].shares === 5);
    check('and a position no longer in the file is taken off', !data.holdings.some((h) => h.symbol === 'BTC-USD'));
  }

  console.log('\nWhat is missing');
  {
    const data = empty();
    const now = new Date();
    const titles = () => finance.setupItems(data, now).map((x) => x.title);
    check('an empty page asks for transactions, bills, budgets and a goal', ['Import your bank transactions', 'Add your bills and paydays', 'Set monthly budgets', 'Set a savings goal'].every((t) => titles().includes(t)));
    const acct = finance.upsert(data, 'accounts', { name: 'Checking', balance: 100 });
    acct.updatedAt = new Date(now.getTime() - 9 * 86400000).toISOString();
    check('a balance not updated for a week asks to be', titles().includes('Update your Checking balance'));
    finance.upsert(data, 'accounts', { id: acct.id, balance: 120 });
    check('and stops once it is', !titles().includes('Update your Checking balance'));
    finance.upsert(data, 'accounts', { name: 'Card', type: 'credit', balance: 50, creditLimit: 1000 });
    check('a card missing its due day and APR says so', finance.setupItems(data, now).some((x) => x.title === 'Finish the Card details' && /due day/.test(x.why) && /APR/.test(x.why)));
    for (let i = 0; i < 4; i++) {
      finance.upsert(data, 'transactions', { date: key(new Date(now.getFullYear(), now.getMonth() - i, Math.min(now.getDate(), 25))), description: 'Recurring Payment Verizon Wireless', amount: -64.5 });
      finance.upsert(data, 'transactions', { date: key(new Date(now.getFullYear(), now.getMonth() - i, Math.min(now.getDate(), 24))), description: 'Recurring Payment Spotify', amount: -11.99 });
    }
    const bill = finance.setupItems(data, now).find((x) => /Verizon/.test(x.title));
    check('a charge every month is suggested as a bill, filled in', bill && bill.go.kind === 'bills' && bill.go.prefill.amount === 64.5 && bill.go.prefill.frequency === 'monthly');
    finance.upsert(data, 'bills', { name: 'Verizon Wireless', amount: 64.5, dueDate: key(now), frequency: 'monthly' });
    check('and not once it is a bill', !finance.setupItems(data, now).some((x) => /Verizon/.test(x.title)));
    const subSuggest = finance.setupItems(data, now).find((x) => /Spotify/.test(x.title));
    check('a known service is suggested as a subscription instead', subSuggest && subSuggest.go.kind === 'subscriptions' && subSuggest.go.prefill.amount === 11.99);
    const due = new Date(finance.setupDue('2026-09-14T15:00:00'));
    check('to-dos are due the Sunday evening after next', due.getDay() === 0 && due.getHours() === 20 && key(due) === '2026-09-20');
  }

  console.log('\nSubscriptions');
  {
    const data = empty();
    const now = new Date();
    const day = (n) => key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n));
    const card = finance.upsert(data, 'accounts', { name: 'Chase Freedom', type: 'credit', balance: 100, last4: '4242' });
    const checking = finance.upsert(data, 'accounts', { name: 'Checking', type: 'checking', balance: 900 });

    const first = finance.applySubscriptionFinding(data, { kind: 'charge', service: 'Netflix', plan: 'Standard', amount: 15.49, frequency: 'monthly', chargedOn: day(32), method: 'card', cardLast4: '4242', source: 'email', ref: 'mail:1' }, now);
    check('the first receipt from a service is a new subscription', first.outcome === 'new' && data.subscriptions.length === 1);
    check('paid with the card whose last four the receipt shows', first.sub.accountId === card.id);
    check('its next charge is a month after the charge', first.sub.nextBilling === finance.advanceBilling(day(32), 'monthly'));
    check('and it waits to be looked at', first.sub.reviewed === false && finance.setupItems(data, now).some((x) => /New subscription found: Netflix/.test(x.title)));

    const second = finance.applySubscriptionFinding(data, { kind: 'charge', service: 'Netflix.com', amount: 15.49, chargedOn: day(2), source: 'email', ref: 'mail:2' }, now);
    check('the next month\'s receipt is a renewal, not a second subscription', second.outcome === 'renewal' && data.subscriptions.length === 1 && second.sub.charges.length === 2);
    check('the same receipt read again counts once', finance.applySubscriptionFinding(data, { kind: 'charge', service: 'Netflix', amount: 15.49, chargedOn: day(2), source: 'email', ref: 'mail:2' }, now).outcome === 'duplicate');
    check('Claude\'s match by id wins over a different name', finance.applySubscriptionFinding(data, { kind: 'upcoming_renewal', service: 'NFLX Streaming', existingId: first.sub.id, amount: 15.49, nextBilling: day(-20), source: 'email' }, now).sub === first.sub);

    const bank = finance.importTransactions(data, [{ date: day(0), description: 'NETFLIX.COM LOS GATOS CA', amount: -15.49 }]);
    check('the bank line for a charge already read from email is not a third charge', bank.subscriptionCharges === 0 && first.sub.charges.length === 2 && first.sub.charges[0].source === 'both');
    check('and is tagged as the subscription', data.transactions[0].subscriptionId === first.sub.id);

    const up = finance.applySubscriptionFinding(data, { kind: 'charge', service: 'Netflix', amount: 17.99, chargedOn: day(-1 + 0), source: 'email', ref: 'mail:3' }, now);
    check('a higher charge is noted as a price rise', up.sub.priceChange && up.sub.priceChange.from === 15.49 && up.sub.priceChange.to === 17.99 && up.sub.amount === 17.99);

    const spot = finance.applySubscriptionFinding(data, { kind: 'charge', service: 'Spotify', plan: 'Premium Individual', amount: 11.99, chargedOn: day(5), method: 'bank', source: 'email', ref: 'mail:4' }, now);
    check('a bank payment with one checking account is paid from it', spot.sub.accountId === checking.id);
    const yearly = finance.applySubscriptionFinding(data, { kind: 'charge', service: 'iCloud+', amount: 35.88, frequency: 'yearly', chargedOn: day(40), method: 'apple', source: 'email', ref: 'mail:5' }, now);
    check('a yearly one renews a year on', yearly.sub.nextBilling === finance.advanceBilling(day(40), 'yearly'));

    check('a one-off order is not a subscription', finance.applySubscriptionFinding(data, { kind: 'not_subscription', service: 'Amazon', amount: 23 }, now).outcome === 'ignored' && data.subscriptions.length === 3);

    const trial = finance.applySubscriptionFinding(data, { kind: 'trial_started', service: 'Duolingo', plan: 'Super', amount: 12.99, trialEnds: day(-2), source: 'email' }, now);
    check('a trial is kept as a trial', trial.outcome === 'new' && trial.sub.status === 'trial');
    check('and ending in two days is a to-do', finance.setupItems(data, now).some((x) => /Duolingo free trial ends/.test(x.title)));

    const cancel = finance.applySubscriptionFinding(data, { kind: 'cancelled', service: 'Spotify', chargedOn: day(1), nextBilling: day(-25), source: 'email' }, now);
    check('a cancellation email cancels it', cancel.outcome === 'cancelled' && cancel.sub.status === 'cancelled' && cancel.sub.endsOn === day(-25));
    finance.applySubscriptionFinding(data, { kind: 'charge', service: 'Spotify', amount: 11.99, chargedOn: day(0), source: 'email', ref: 'mail:6' }, now);
    check('money taken after cancelling is flagged', !!cancel.sub.chargedAfterCancel && finance.setupItems(data, now).some((x) => /charged you after you cancelled/.test(x.title)));

    const s = finance.subscriptionsSummary(data, now);
    const nf = s.list.find((x) => x.name === 'Netflix');
    check('monthly cost counts a yearly one as a twelfth and leaves out cancelled and trials', s.monthly === Math.round((17.99 + 35.88 / 12) * 100) / 100);
    check('a cancelled one costs nothing a month', s.list.find((x) => x.name === 'Spotify').monthly === 0);
    check('grouped by what pays for it', s.byPayment.some((g) => g.accountId === card.id && g.count === 1));
    check('each shows when it charges next', nf.nextCharge && nf.daysUntil >= 0 && nf.paidWith.label === 'Chase Freedom ••4242');

    finance.upsert(data, 'subscriptions', { id: first.sub.id, reviewed: true });
    check('marking it right clears the to-do', !finance.setupItems(data, now).some((x) => /New subscription found: Netflix/.test(x.title)));
    finance.remove(data, 'subscriptions', trial.sub.id);
    check('one found in email and deleted is not found again', finance.applySubscriptionFinding(data, { kind: 'charge', service: 'Duolingo', amount: 12.99, chargedOn: day(0), source: 'email', ref: 'mail:7' }, now).outcome === 'ignored');
    check('a subscription typed in by hand needs a price', throws(() => finance.upsert(data, 'subscriptions', { name: 'Gym' }), /^Amount: required/));
  }

  console.log('\nNews queries');
  check('company suffixes come off the search name', finance.cleanName('Lululemon Athletica Inc.', 'LULU') === 'Lululemon Athletica');
  check('a name that is just the ticker is not used', finance.cleanName('NKE', 'NKE') === '');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
