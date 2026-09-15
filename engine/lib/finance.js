'use strict';
/**
 * finance.js - where your money is, what is coming due, and the news around it.
 *
 * Everything here is typed in by you, or read from a file you dropped (a bank
 * CSV, a positions export). Mellow does not connect to a bank, never asks for
 * a login or an account number, and cannot move money. Balances are whatever
 * you last said they were, with the date you said it, so a stale number looks
 * stale. When your transactions or email show money going somewhere that is an
 * account of your own (Coinbase, Venmo, a brokerage), that account is made with
 * no balance, and a to-do asks you to fill it in.
 *
 * Kept in finance.json next to tasks.json, as plain readable JSON, for the same
 * reason history is: you can open it, fix it, or delete it.
 *
 * The morning brief is built once a day, after morningHour: the markets, the
 * business headlines, what is being written about the stocks you hold or
 * follow, and the money stories that reach a person rather than a fund
 * (rates, loans, prices). Like the News page, the ranking is the feed's own.
 * It shows prices and headlines. It does not advise, predict or trade.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const news = require('./news');
const stocks = require('./stocks');
const privacy = require('./ai/privacy');

// RATCHET_DATA_DIR lets a test server use a scratch copy instead of yours.
const ROOT = process.env.RATCHET_DATA_DIR || path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'finance.json');
const BRIEF_FILE = path.join(ROOT, 'finance-brief.json');

const ACCOUNT_TYPES = ['checking', 'savings', 'credit', 'investment', 'retirement', 'loan', 'cash', 'other'];
const DEBT_TYPES = ['credit', 'loan'];
const CASH_TYPES = ['checking', 'savings', 'cash'];
const FREQUENCIES = ['monthly', 'weekly', 'biweekly', 'yearly', 'once'];
const SUB_FREQUENCIES = ['monthly', 'yearly', 'quarterly', 'weekly'];
const SUB_STATUSES = ['active', 'trial', 'paused', 'cancelled'];
// How a subscription is paid when it is not tied to one of your accounts.
const PAY_METHODS = ['card', 'bank', 'paypal', 'apple', 'google', 'other'];

const DEFAULT_SETTINGS = {
  morningHour: 6,
  markets: [
    { symbol: '^GSPC', name: 'S&P 500' },
    { symbol: '^IXIC', name: 'Nasdaq' },
    { symbol: '^DJI', name: 'Dow' },
    { symbol: '^TNX', name: '10-yr yield' },
    { symbol: 'BTC-USD', name: 'Bitcoin' },
    { symbol: 'GC=F', name: 'Gold' },
  ],
  // Money stories that reach a person rather than a fund.
  moneyQuery: '(inflation OR "interest rates" OR "student loans" OR "credit card" OR "gas prices" OR "Social Security") (Americans OR consumers OR households)',
  headlineCount: 8,
};

/* --------------------------------- storage ------------------------------- */

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { return fallback; }
}

function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function load() {
  const raw = readJson(DATA_FILE, {});
  const data = {
    _comment: raw._comment || 'Your finances, as you entered them on the Finance page. No logins, no account numbers. Safe to edit by hand while the engine runs.',
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
    transactions: Array.isArray(raw.transactions) ? raw.transactions : [],
    bills: Array.isArray(raw.bills) ? raw.bills : [],
    budgets: Array.isArray(raw.budgets) ? raw.budgets : [],
    goals: Array.isArray(raw.goals) ? raw.goals : [],
    holdings: Array.isArray(raw.holdings) ? raw.holdings : [],
    subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [],
    history: Array.isArray(raw.history) ? raw.history : [],
  };
  return data;
}

function save(data) {
  writeJson(DATA_FILE, data);
}

/* -------------------------------- validation ----------------------------- */

const pad = (n) => String(n).padStart(2, '0');
function dayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseDay(k) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 ? d : null;
}
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function round2(n) { return Math.round(n * 100) / 100; }

function str(max, required) {
  return (v) => {
    const s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
    if (required && !s) throw new Error('required');
    return s;
  };
}
function num({ required, min, places } = {}) {
  return (v) => {
    if (v === '' || v == null) { if (required) throw new Error('required'); return null; }
    const n = Number(String(v).replace(/[$,\s]/g, ''));
    if (!Number.isFinite(n) || Math.abs(n) > 1e10) throw new Error('not a number');
    if (min != null && n < min) throw new Error(`must be at least ${min}`);
    // Money is cents; a share count can be a sliver of a bitcoin.
    return places ? Math.round(n * 10 ** places) / 10 ** places : round2(n);
  };
}
function oneOf(list, dflt) { return (v) => (list.includes(v) ? v : dflt); }
function bool() { return (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'on'; }
function day(required) {
  return (v) => {
    if (!v) { if (required) throw new Error('required'); return null; }
    if (!parseDay(v)) throw new Error('not a date');
    return String(v);
  };
}
function ticker() {
  return (v) => {
    const s = String(v || '').trim().toUpperCase();
    if (!/^[A-Z0-9.^=-]{1,12}$/.test(s)) throw new Error('not a ticker symbol');
    return s;
  };
}

function dayOfMonth() {
  return (v) => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 31) throw new Error('a day of the month, 1 to 31');
    return n;
  };
}
function last4() {
  return (v) => {
    const s = String(v == null ? '' : v).replace(/\D/g, '');
    if (!s) return '';
    // Only ever the last four. A full card number typed here is cut down, never stored.
    return s.slice(-4);
  };
}

const CARD_AUTOPAY = ['none', 'minimum', 'statement', 'full'];

const KINDS = {
  accounts: {
    label: 'account', max: 60,
    fields: {
      name: str(60, true), type: oneOf(ACCOUNT_TYPES, 'checking'), institution: str(60),
      balance: num({ required: true }), note: str(200), private: bool(),
      // Credit cards only. Ignored for every other type.
      last4: last4(), creditLimit: num({ min: 0 }), apr: num({ min: 0 }), statementDay: dayOfMonth(), dueDay: dayOfMonth(),
      statementBalance: num({ min: 0 }), minimumPayment: num({ min: 0 }), autopay: oneOf(CARD_AUTOPAY, 'none'),
      annualFee: num({ min: 0 }), rewards: str(120),
    },
  },
  transactions: {
    label: 'transaction', max: 10000,
    fields: { date: day(true), description: str(120, true), amount: num({ required: true }), category: str(40), private: bool() },
  },
  bills: {
    label: 'bill', max: 150,
    fields: {
      name: str(60, true), amount: num({ required: true, min: 0 }), dueDate: day(true),
      frequency: oneOf(FREQUENCIES, 'monthly'), income: bool(), autopay: bool(), category: str(40), private: bool(),
    },
  },
  budgets: {
    label: 'budget', max: 60,
    fields: { category: str(40, true), monthly: num({ required: true, min: 0 }), private: bool() },
  },
  goals: {
    label: 'goal', max: 40,
    fields: { name: str(60, true), target: num({ required: true, min: 0.01 }), saved: num({ min: 0 }), by: day(false), private: bool() },
  },
  holdings: {
    label: 'holding', max: 80,
    fields: { symbol: ticker(), shares: num({ required: true, min: 0, places: 8 }), costBasis: num({ min: 0 }), accountId: str(40), private: bool() },
  },
  subscriptions: {
    label: 'subscription', max: 200,
    fields: {
      name: str(60, true), plan: str(60), amount: num({ required: true, min: 0 }), frequency: oneOf(SUB_FREQUENCIES, 'monthly'),
      nextBilling: day(false), startedOn: day(false), trialEnds: day(false), status: oneOf(SUB_STATUSES, 'active'),
      // Paid from one of your accounts (checking or a card), or else by method.
      accountId: str(40), method: oneOf(PAY_METHODS, 'card'),
      category: str(40), note: str(200), reviewed: bool(), private: bool(),
    },
  },
};

const FIELD_NAMES = {
  name: 'Name', type: 'Type', balance: 'Balance', date: 'Date', description: 'Description', amount: 'Amount',
  dueDate: 'Due date', category: 'Category', monthly: 'Monthly limit', target: 'Target', saved: 'Saved so far',
  by: 'Target date', symbol: 'Symbol', shares: 'Shares', costBasis: 'Cost basis', creditLimit: 'Credit limit',
  apr: 'APR', statementDay: 'Statement closes on', dueDay: 'Payment due on', statementBalance: 'Statement balance',
  minimumPayment: 'Minimum payment', annualFee: 'Annual fee', plan: 'Plan', nextBilling: 'Next charge', startedOn: 'Started',
  trialEnds: 'Trial ends', status: 'Status', method: 'Paid with', note: 'Note',
};

/* ------------------------------- credit cards ---------------------------- */

/**
 * A card with a due day gets a bill of its own, kept in step with the card:
 * the statement balance (or the minimum, if that is all you entered) due on
 * that day each month. It shows in Bills with everything else, and paying it
 * lowers the card's balance instead of being logged as spending, since moving
 * money onto a card is not buying something twice.
 */
function syncCardBill(data, account) {
  const existing = data.bills.find((b) => b.cardId === account.id);
  if (account.type !== 'credit' || !account.dueDay) {
    if (existing) data.bills.splice(data.bills.indexOf(existing), 1);
    return null;
  }
  const today = startOfDay(new Date());
  const amount = account.statementBalance != null ? account.statementBalance
    : account.minimumPayment != null ? account.minimumPayment : 0;
  const bill = existing || { id: crypto.randomBytes(6).toString('hex'), createdAt: new Date().toISOString(), paid: [], cardId: account.id };
  Object.assign(bill, {
    name: `${account.name} payment`,
    amount: round2(amount),
    frequency: 'monthly',
    income: false,
    autopay: account.autopay && account.autopay !== 'none',
    category: 'Credit card',
    private: !!account.private,
  });
  if (!parseDay(bill.dueDate) || bill.dueDay !== account.dueDay) {
    // Starts from this month's due date, so a card added today does not
    // arrive with last month's payment already late.
    bill.dueDate = dayKey(clampDate(today.getFullYear(), today.getMonth(), account.dueDay));
    bill.dueDay = account.dueDay;
  }
  if (!existing) data.bills.push(bill);
  return bill;
}

function cardSummary(a, upcoming, today) {
  const next = (dom) => {
    if (!dom) return null;
    let d = clampDate(today.getFullYear(), today.getMonth(), dom);
    if (d < today) d = clampDate(today.getFullYear(), today.getMonth() + 1, dom);
    return dayKey(d);
  };
  const balance = Math.abs(Number(a.balance) || 0);
  const bill = upcoming.find((u) => u.cardId === a.id && !u.paid);
  const monthlyInterest = a.apr ? round2(balance * (a.apr / 100) / 12) : null;
  return {
    id: a.id, name: a.name, institution: a.institution || '', last4: a.last4 || '', private: !!a.private,
    balance: round2(balance), creditLimit: a.creditLimit ?? null, available: a.creditLimit != null ? round2(a.creditLimit - balance) : null,
    utilization: a.creditLimit ? (balance / a.creditLimit) * 100 : null,
    apr: a.apr ?? null, statementBalance: a.statementBalance ?? null, minimumPayment: a.minimumPayment ?? null,
    statementDay: a.statementDay || null, dueDay: a.dueDay || null, autopay: a.autopay || 'none',
    nextStatement: next(a.statementDay), nextDue: bill ? bill.date : next(a.dueDay), dueIn: bill ? bill.daysAway : null,
    overdue: !!(bill && bill.overdue), billId: bill ? bill.billId : null,
    // What carrying today's balance for a month would cost at this APR, roughly.
    monthlyInterestIfCarried: monthlyInterest,
    annualFee: a.annualFee ?? null, rewards: a.rewards || '', updatedAt: a.updatedAt || null,
  };
}

/** The checked fields of one item. A partial update leaves the fields it does not mention alone. */
function validate(kind, input, existing) {
  const out = {};
  for (const [field, check] of Object.entries(KINDS[kind].fields)) {
    if (existing && !(field in input)) continue;
    try {
      out[field] = check(input[field]);
    } catch (e) {
      throw new Error(`${FIELD_NAMES[field] || field}: ${e.message}.`);
    }
  }
  return out;
}

/**
 * Add or change one item. With an id that exists, the given fields are merged
 * into it; without one, a new item is made. Throws with a readable message.
 */
function upsert(data, kind, input) {
  const spec = KINDS[kind];
  if (!spec) throw new Error('Unknown kind of item.');
  if (kind === 'subscriptions') subsOf(data);
  const list = data[kind];
  const id = input && typeof input.id === 'string' ? input.id : '';
  const existing = id ? list.find((x) => x.id === id) : null;
  if (id && !existing) throw new Error(`That ${spec.label} is no longer there.`);
  if (!existing && list.length >= spec.max) throw new Error(`That is the most ${kind} Mellow keeps (${spec.max}).`);

  const out = existing ? { ...existing } : { id: crypto.randomBytes(6).toString('hex'), createdAt: new Date().toISOString() };
  Object.assign(out, validate(kind, input, existing));

  if (kind === 'accounts' && (!existing || 'balance' in input)) out.updatedAt = new Date().toISOString();
  if (kind === 'budgets') {
    const clash = list.find((b) => b.id !== out.id && b.category.toLowerCase() === out.category.toLowerCase());
    if (clash) throw new Error(`There is already a budget for ${clash.category}.`);
  }
  if (kind === 'bills' && !Array.isArray(out.paid)) out.paid = [];
  if (kind === 'bills' && existing && existing.cardId) throw new Error('That bill belongs to a credit card. Change the card instead.');
  if (kind === 'accounts' && out.type !== 'credit') {
    for (const f of ['last4', 'creditLimit', 'apr', 'statementDay', 'dueDay', 'statementBalance', 'minimumPayment', 'autopay', 'annualFee', 'rewards']) delete out[f];
  }
  if (kind === 'subscriptions') {
    if (!Array.isArray(out.charges)) out.charges = [];
    if (out.accountId && !data.accounts.some((a) => a.id === out.accountId)) out.accountId = '';
    if (out.status === 'cancelled' && (!existing || existing.status !== 'cancelled')) out.cancelledOn = dayKey(new Date());
    if (out.status !== 'cancelled') delete out.cancelledOn;
    // Changing one Mellow found is as good as saying it is right.
    if (existing && existing.detected && !('reviewed' in input)) out.reviewed = true;
    if (!existing && !out.startedOn) out.startedOn = dayKey(new Date());
  }

  if (existing) list[list.indexOf(existing)] = out;
  else list.push(out);
  if (kind === 'accounts') syncCardBill(data, out);
  if (kind === 'transactions') list.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out;
}

function remove(data, kind, id) {
  if (!KINDS[kind]) throw new Error('Unknown kind of item.');
  if (kind === 'subscriptions') subsOf(data);
  const i = data[kind].findIndex((x) => x.id === id);
  if (i === -1) throw new Error('That is no longer there.');
  if (kind === 'bills' && data.bills[i].cardId) throw new Error('That bill belongs to a credit card. Remove its due day, or the card, instead.');
  const [gone] = data[kind].splice(i, 1);
  if (kind === 'subscriptions') {
    data.transactions.forEach((t) => { if (t.subscriptionId === id) delete t.subscriptionId; });
    // One found in your email and deleted is not found again from the next receipt.
    if (gone.detected) {
      const d = detectSettings(data);
      d.dismissed = [...new Set([...d.dismissed, `sub:${subKey(gone.name)}`])];
    }
  }
  if (kind === 'accounts') {
    data.holdings.forEach((h) => { if (h.accountId === id) h.accountId = ''; });
    subsOf(data).forEach((s) => { if (s.accountId === id) s.accountId = ''; });
    data.bills = data.bills.filter((b) => b.cardId !== id);
    data.transactions.forEach((t) => {
      if (t.accountId === id) delete t.accountId;
      if (t.transferAccountId === id) delete t.transferAccountId;
    });
    // An account Mellow found and you deleted is not found again.
    if (gone.detected && gone.detected.key) {
      const d = detectSettings(data);
      d.dismissed = [...new Set([...d.dismissed, gone.detected.key])];
    }
  }
  return gone;
}

/* ---------------------------------- bills -------------------------------- */

function clampDate(y, m, d) {
  const last = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(d, last));
}

/** Every date this bill falls on between from and to, inclusive. */
function occurrences(bill, from, to) {
  const anchor = parseDay(bill.dueDate);
  if (!anchor) return [];
  const out = [];
  const f = startOfDay(from);
  const t = startOfDay(to);
  const push = (d) => { if (d >= anchor && d >= f && d <= t) out.push(d); };

  switch (bill.frequency) {
    case 'once':
      push(anchor);
      break;
    case 'weekly':
    case 'biweekly': {
      const step = bill.frequency === 'weekly' ? 7 : 14;
      const gap = Math.max(0, Math.floor((f - anchor) / 86400000 / step) - 1);
      for (let d = addDays(anchor, gap * step); d <= t; d = addDays(d, step)) push(d);
      break;
    }
    case 'yearly':
      for (let y = f.getFullYear(); y <= t.getFullYear(); y++) push(clampDate(y, anchor.getMonth(), anchor.getDate()));
      break;
    default: // monthly
      for (let y = f.getFullYear(), m = f.getMonth(); y < t.getFullYear() || (y === t.getFullYear() && m <= t.getMonth()); m === 11 ? (y++, m = 0) : m++) {
        push(clampDate(y, m, anchor.getDate()));
      }
  }
  return out;
}

/** This month's share of a bill, so a yearly insurance premium counts as a twelfth. */
function monthlyEquivalent(bill) {
  const a = Number(bill.amount) || 0;
  return { weekly: a * 52 / 12, biweekly: a * 26 / 12, yearly: a / 12, once: 0 }[bill.frequency] ?? a;
}

function markPaid(data, id, occurrence, opts = {}) {
  const bill = data.bills.find((b) => b.id === id);
  if (!bill) throw new Error('That bill is no longer there.');
  const today = startOfDay(new Date());
  let when = occurrence ? parseDay(occurrence) : null;
  if (!when) {
    // The oldest one still open: last month's rent before next month's.
    const open = occurrences(bill, addDays(today, -60), addDays(today, 400))
      .filter((d) => !(bill.paid || []).includes(dayKey(d)));
    when = open[0] || null;
  }
  if (!when) throw new Error('Nothing left to mark on that one.');
  const key = dayKey(when);
  bill.paid = [...new Set([...(bill.paid || []), key])].sort().slice(-36);

  if (bill.cardId) {
    // A card payment moves money onto the card: its balance goes down, and
    // it is not spending, so no transaction.
    const card = data.accounts.find((a) => a.id === bill.cardId);
    const amount = opts.amount != null && Number.isFinite(Number(opts.amount)) ? Math.max(0, Number(opts.amount)) : bill.amount;
    if (card) {
      bill.paidAmounts = { ...(bill.paidAmounts || {}), [key]: { amount, statementBalance: card.statementBalance ?? null } };
      card.balance = round2(Math.max(0, Math.abs(card.balance) - amount));
      if (card.statementBalance != null) card.statementBalance = round2(Math.max(0, card.statementBalance - amount));
      card.updatedAt = new Date().toISOString();
      syncCardBill(data, card);
    }
    return { bill, occurrence: key, transaction: null };
  }

  let txn = null;
  if (opts.log !== false && bill.amount > 0) {
    txn = upsert(data, 'transactions', {
      date: dayKey(when > today ? today : when),
      description: bill.name,
      amount: bill.income ? bill.amount : -bill.amount,
      category: bill.category || (bill.income ? 'Income' : 'Bills'),
    });
    txn.fromBill = `${bill.id}:${key}`;
  }
  return { bill, occurrence: key, transaction: txn };
}

function unmarkPaid(data, id, occurrence) {
  const bill = data.bills.find((b) => b.id === id);
  if (!bill) throw new Error('That bill is no longer there.');
  bill.paid = (bill.paid || []).filter((k) => k !== occurrence);
  const undo = (bill.paidAmounts || {})[occurrence];
  if (bill.cardId && undo) {
    const card = data.accounts.find((a) => a.id === bill.cardId);
    if (card) {
      card.balance = round2(Math.abs(card.balance) + undo.amount);
      if (undo.statementBalance != null) card.statementBalance = undo.statementBalance;
      syncCardBill(data, card);
    }
    delete bill.paidAmounts[occurrence];
  }
  const tag = `${bill.id}:${occurrence}`;
  data.transactions = data.transactions.filter((t) => t.fromBill !== tag);
  return bill;
}

/* --------------------------- imports from your bank ------------------------ */

function daysBetween(a, b) {
  const x = parseDay(a), y = parseDay(b);
  return x && y ? Math.round((y - x) / 86400000) : Infinity;
}

/** A description with the bank's noise taken off: "Sign Debit Oasis" and "OASIS" are the same shop. */
function normDesc(s) {
  return String(s || '').toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/^(sign (debit|credit)|recurring payment|p debit|debit card|debit|pos( debit)?|purchase|ach (debit|credit))\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const firstWord = (s) => normDesc(s).split(' ')[0] || '';

function detectSettings(data) {
  data.settings = data.settings || {};
  const d = data.settings.detect && typeof data.settings.detect === 'object' ? data.settings.detect : {};
  d.dismissed = Array.isArray(d.dismissed) ? d.dismissed : [];
  data.settings.detect = d;
  return d;
}

/**
 * The account a bank export came from. Only the last four digits are ever
 * kept. An account you deleted after it was found is not made again.
 */
function bankAccountFor(data, { last4, name, type } = {}) {
  const four = String(last4 || '').replace(/\D/g, '').slice(-4);
  if (four.length !== 4) return null;
  const found = data.accounts.find((a) => (a.detected && a.detected.last4 === four) || a.last4 === four);
  if (found) return found;
  const key = `bank-${four}`;
  if (detectSettings(data).dismissed.includes(key) || data.accounts.length >= KINDS.accounts.max) return null;
  const a = {
    id: crypto.randomBytes(6).toString('hex'), createdAt: new Date().toISOString(),
    name: name || `Checking ••${four}`, type: ACCOUNT_TYPES.includes(type) ? type : 'checking', institution: '', balance: null, note: '', private: false,
    detected: { key, from: 'import', at: new Date().toISOString(), last4: four, evidence: `a bank export for the account ending in ${four}`, how: 'Bank exports have no balance in them. Copy it from your bank\'s app.' },
  };
  data.accounts.push(a);
  return a;
}

/**
 * Transactions from a bank export, added once however many times the same
 * export is dropped. Rows already in Finance are skipped (the same date, amount
 * and description, counted, so three identical Kindle purchases on one day
 * stay three). A pending charge that has since posted replaces itself, and a
 * bill you marked paid by hand is not added a second time when the bank shows it.
 *
 * rows: [{ date, description, amount, category, pending }]
 * Returns what happened to each row, in order, and the accounts found along the way.
 */
function importTransactions(data, rows, opts = {}) {
  const accountsBefore = new Set(data.accounts.map((a) => a.id));
  const account = opts.account ? bankAccountFor(data, opts.account) : null;
  const sig = (t) => `${t.date}|${Number(t.amount).toFixed(2)}|${normDesc(t.description)}`;
  const have = new Map();
  for (const t of data.transactions) {
    if (!have.has(sig(t))) have.set(sig(t), []);
    have.get(sig(t)).push(t);
  }
  const matched = new Set();
  const fresh = [];
  const results = [];
  let added = 0, duplicates = 0, settled = 0;

  for (const row of rows || []) {
    let clean;
    try {
      clean = validate('transactions', row);
    } catch (e) {
      results.push({ status: 'error', error: e.message });
      continue;
    }
    const same = (have.get(sig(clean)) || []).filter((t) => !matched.has(t));
    if (same.length) {
      // Prefer the pending copy, so a charge that has posted stops saying pending.
      const twin = (!row.pending && same.find((t) => t.pending)) || same[0];
      matched.add(twin);
      if (twin.pending && !row.pending) {
        Object.assign(twin, clean);
        delete twin.pending;
        settled++;
        results.push({ status: 'settled' });
      } else {
        duplicates++;
        results.push({ status: 'duplicate' });
      }
      continue;
    }
    if (!row.pending) {
      const twin = data.transactions.find((t) => (t.pending || t.fromBill) && !matched.has(t) &&
        Math.abs(t.amount - clean.amount) < 0.005 && Math.abs(daysBetween(t.date, clean.date)) <= 5 &&
        (t.fromBill || firstWord(t.description) === firstWord(clean.description)));
      if (twin) {
        matched.add(twin);
        if (twin.pending) {
          Object.assign(twin, clean);
          delete twin.pending;
          settled++;
          results.push({ status: 'settled' });
        } else {
          twin.bankMatched = true;
          duplicates++;
          results.push({ status: 'duplicate' });
        }
        continue;
      }
    }
    if (data.transactions.length + fresh.length >= KINDS.transactions.max) {
      results.push({ status: 'error', error: `That is the most transactions Mellow keeps (${KINDS.transactions.max}).` });
      continue;
    }
    const t = { id: crypto.randomBytes(6).toString('hex'), createdAt: new Date().toISOString(), ...clean, source: 'import' };
    if (row.pending) t.pending = true;
    if (account) t.accountId = account.id;
    fresh.push(t);
    added++;
    results.push({ status: 'added', id: t.id });
  }

  data.transactions.push(...fresh);
  data.transactions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const detected = detectAccounts(data);
  if (account && !accountsBefore.has(account.id)) detected.unshift(account.name);
  let subscriptionCharges = 0;
  try { subscriptionCharges = matchSubscriptionTransactions(data); } catch (_) {}
  return { added, duplicates, settled, results, subscriptionCharges, account: account ? { id: account.id, name: account.name } : null, detected };
}

/**
 * Positions from a brokerage or crypto export. The file is the whole account,
 * so a position that is no longer in it (sold) is taken off that account.
 * rows: [{ symbol, shares, costBasis }]; opts: { account: name, cash, type }
 */
function importHoldings(data, rows, opts = {}) {
  const name = String(opts.account || 'Brokerage').slice(0, 60);
  const inst = INSTITUTIONS.find((i) => i.re.test(name));
  let account = data.accounts.find((a) => a.name.toLowerCase() === name.toLowerCase() || (inst && accountMatches(a, inst)));
  let created = false;
  if (!account) {
    if (data.accounts.length >= KINDS.accounts.max) throw new Error(`That is the most accounts Mellow keeps (${KINDS.accounts.max}).`);
    account = {
      id: crypto.randomBytes(6).toString('hex'), createdAt: new Date().toISOString(), name: inst ? inst.name : name,
      type: opts.type || (inst ? inst.type : 'investment'), institution: inst ? inst.name : '', balance: null, note: '', private: false,
      detected: { key: inst ? inst.key : `holdings-${normDesc(name).replace(/ /g, '-')}`, from: 'import', at: new Date().toISOString(), evidence: `a positions file from ${name}`, how: inst ? inst.note : '' },
    };
    data.accounts.push(account);
    created = true;
  }
  if (opts.cash != null && Number.isFinite(Number(opts.cash))) {
    account.balance = round2(Number(opts.cash));
    account.updatedAt = new Date().toISOString();
  }

  const results = [];
  const kept = new Set();
  let added = 0, updated = 0;
  for (const row of rows || []) {
    let clean;
    try {
      clean = validate('holdings', { symbol: row.symbol, shares: row.shares, costBasis: row.costBasis == null ? '' : row.costBasis, accountId: account.id });
    } catch (e) {
      results.push({ status: 'error', error: e.message });
      continue;
    }
    const existing = data.holdings.find((h) => h.symbol === clean.symbol && (h.accountId === account.id || !h.accountId));
    if (existing) {
      Object.assign(existing, { shares: clean.shares, accountId: account.id, updatedAt: new Date().toISOString() });
      if (clean.costBasis != null) existing.costBasis = clean.costBasis;
      kept.add(existing.id);
      updated++;
      results.push({ status: 'updated', id: existing.id });
    } else if (data.holdings.length >= KINDS.holdings.max) {
      results.push({ status: 'error', error: `That is the most holdings Mellow keeps (${KINDS.holdings.max}).` });
    } else {
      const h = { id: crypto.randomBytes(6).toString('hex'), createdAt: new Date().toISOString(), ...clean, updatedAt: new Date().toISOString() };
      data.holdings.push(h);
      kept.add(h.id);
      added++;
      results.push({ status: 'added', id: h.id });
    }
  }
  let removed = 0;
  if (opts.complete !== false && results.some((r) => r.status !== 'error')) {
    const before = data.holdings.length;
    data.holdings = data.holdings.filter((h) => h.accountId !== account.id || kept.has(h.id));
    removed = before - data.holdings.length;
  }
  return { account: { id: account.id, name: account.name, created }, added, updated, removed, results };
}

/* ------------------------------ accounts it finds -------------------------- */

/*
 * Services money moves to that are accounts of your own. Matched against
 * transaction descriptions, and against who sent an email that is about an
 * account (a deposit, a trade, a statement, a sign-in), never a promotion.
 * `always`: any payment there is money into the account. Otherwise the row has
 * to look like a transfer, since "PayPal" alone is usually a purchase.
 * `p2p`: money sent to friends from it is spending, so a transfer into it
 * still counts as spending. Money into investments does not.
 */
const INSTITUTIONS = [
  { key: 'etrade', name: 'E*TRADE', type: 'investment', always: true, re: /\be\s?\*\s?trade\b|\betrade\b|\bmorgan stanley\b|\bmspbna\b/i, domains: ['etrade.com'],
    note: 'Transfers to E*TRADE show on bank statements as Morgan Stanley. For holdings, download your positions as a CSV from E*TRADE (Portfolios, then the download icon) and drop it on Finance.' },
  { key: 'coinbase', name: 'Coinbase', type: 'investment', always: true, re: /\bcoinbase\b/i, domains: ['coinbase.com'],
    note: 'For holdings, download a transaction report CSV from Coinbase (Profile, Statements, Generate report) and drop it on Finance. Mellow adds up what you hold.' },
  { key: 'phantom', name: 'Phantom wallet', type: 'investment', always: true, re: /\bphantom\b/i, domains: ['phantom.app', 'phantom.com'],
    note: 'A self-custody wallet has no login to link. Add what it holds under Holdings (SOL-USD for Solana, for example) and update the amounts now and then.' },
  { key: 'axiom', name: 'Axiom', type: 'investment', always: true, re: /\baxiom\.trade\b|\baxiom trade\b/i, domains: ['axiom.trade'],
    note: 'Axiom trades from a Solana wallet. Add the tokens as holdings, or track the wallet balance by hand.' },
  { key: 'robinhood', name: 'Robinhood', type: 'investment', always: true, re: /\brobinhood\b/i, domains: ['robinhood.com'], note: 'Download positions as a CSV and drop it on Finance.' },
  { key: 'fidelity', name: 'Fidelity', type: 'investment', always: true, re: /\bfidelity\b/i, domains: ['fidelity.com'], note: 'Download positions as a CSV (Positions, then Download) and drop it on Finance.' },
  { key: 'schwab', name: 'Charles Schwab', type: 'investment', always: true, re: /\bschwab\b/i, domains: ['schwab.com'], note: 'Export positions as a CSV and drop it on Finance.' },
  { key: 'vanguard', name: 'Vanguard', type: 'investment', always: true, re: /\bvanguard\b/i, domains: ['vanguard.com'], note: 'Download holdings as a CSV and drop it on Finance.' },
  { key: 'webull', name: 'Webull', type: 'investment', always: true, re: /\bwebull\b/i, domains: ['webull.com'] },
  { key: 'acorns', name: 'Acorns', type: 'investment', always: true, re: /\bacorns\b/i, domains: ['acorns.com'] },
  { key: 'wealthfront', name: 'Wealthfront', type: 'investment', always: true, re: /\bwealthfront\b/i, domains: ['wealthfront.com'] },
  { key: 'betterment', name: 'Betterment', type: 'investment', always: true, re: /\bbetterment\b/i, domains: ['betterment.com'] },
  { key: 'kraken', name: 'Kraken', type: 'investment', always: true, re: /\bkraken\b/i, domains: ['kraken.com'] },
  { key: 'gemini', name: 'Gemini', type: 'investment', always: true, re: /\bgemini (trust|exchange)\b/i, domains: ['gemini.com'] },
  { key: 'cryptocom', name: 'Crypto.com', type: 'investment', always: true, re: /\bcrypto\.com\b/i, domains: ['crypto.com'] },
  { key: 'kalshi', name: 'Kalshi', type: 'other', always: true, re: /\bkalshi\b/i, domains: ['kalshi.com'], note: 'Copy the balance from the Kalshi app.' },
  { key: 'polymarket', name: 'Polymarket', type: 'other', always: true, re: /\bpolymarket\b/i, domains: ['polymarket.com'] },
  { key: 'venmo', name: 'Venmo', type: 'cash', p2p: true, re: /\bvenmo\b/i, domains: ['venmo.com'], note: 'Copy the balance from the Venmo app. Money sent to friends still counts as spending.' },
  { key: 'paypal', name: 'PayPal', type: 'cash', p2p: true, re: /\bpaypal\b/i, domains: ['paypal.com'] },
  { key: 'cashapp', name: 'Cash App', type: 'cash', p2p: true, re: /\bcash\s?app\b|\bsquare cash\b/i, domains: ['cash.app', 'square.com'] },
  { key: 'applecash', name: 'Apple Cash', type: 'cash', p2p: true, re: /\bapple (cash|pay)\b/i, domains: [] },
  { key: 'chime', name: 'Chime', type: 'checking', re: /\bchime\b/i, domains: ['chime.com'] },
  { key: 'sofi', name: 'SoFi', type: 'savings', re: /\bsofi\b/i, domains: ['sofi.com', 'sofi.org'] },
  { key: 'ally', name: 'Ally Bank', type: 'savings', re: /\bally bank\b/i, domains: ['ally.com'] },
];

const TRANSFERISH = /transfer|deposit|withdraw|cash ?out|add(ed)? money|instant|\bach\b|\bxfer\b|topper|onramp/i;
const ACCOUNT_MAIL = /\b(your (account|order|trade|deposit|withdrawal|transfer|statement|portfolio|balance|wallet|funds)|deposit|withdrawal|transfer|order (filled|executed|confirmation)|trade confirmation|statement|receipt|you (bought|sold|received|sent)|welcome to|verify|confirm your|sign-?in|new device|security alert|funds (are )?available)\b/i;

function accountMatches(a, inst) {
  return (a.detected && a.detected.key === inst.key) || inst.re.test(a.name || '') || inst.re.test(a.institution || '');
}

function newDetected(data, inst, info) {
  if (data.accounts.length >= KINDS.accounts.max) return null;
  const a = {
    id: crypto.randomBytes(6).toString('hex'), createdAt: new Date().toISOString(),
    name: inst.name, type: inst.type, institution: inst.name, balance: null, note: '', private: false,
    detected: { key: inst.key, from: info.from, at: new Date().toISOString(), evidence: info.evidence || '', count: info.count || 1, how: inst.note || '' },
  };
  data.accounts.push(a);
  return a;
}

/**
 * Accounts of your own that your transactions point to, made for you so you
 * remember to fill them in. Returns the names of any it made. A transfer into
 * an investment account is tagged with it, so it is not counted as spending.
 */
function detectAccounts(data) {
  const dismissed = detectSettings(data).dismissed;
  const byKey = new Map();
  const today = dayKey(new Date());
  for (const t of data.transactions) {
    if (t.fromBill) continue;
    const inst = INSTITUTIONS.find((i) => i.re.test(t.description || '') && (i.always || TRANSFERISH.test(t.description || '') || /transfer/i.test(t.category || '')));
    if (!inst) continue;
    if (!byKey.has(inst.key)) byKey.set(inst.key, { inst, txns: [] });
    byKey.get(inst.key).txns.push(t);
  }
  const created = [];
  for (const { inst, txns } of byKey.values()) {
    const latest = txns[0];
    const evidence = `${latest.description}, ${latest.amount < 0 ? '−' : '+'}$${Math.abs(latest.amount).toFixed(2)} on ${latest.date}` + (txns.length > 1 ? ` (${txns.length} in all)` : '');
    let acct = data.accounts.find((a) => accountMatches(a, inst));
    if (!acct) {
      // An app you last moved money to years ago is probably not one you use.
      if (dismissed.includes(inst.key) || daysBetween(latest.date, today) > 180) continue;
      acct = newDetected(data, inst, { from: 'transactions', evidence, count: txns.length });
      if (!acct) continue;
      created.push(acct.name);
    } else if (acct.detected && acct.detected.key === inst.key && acct.detected.from === 'transactions') {
      acct.detected.evidence = evidence;
      acct.detected.count = txns.length;
    }
    if (!inst.p2p) for (const t of txns) t.transferAccountId = acct.id;
  }
  return created;
}

/**
 * An account email from a service in the list above makes the account too.
 * msg: { fromAddress, subject, labels }. Returns the account made, or null.
 */
function detectFromEmail(data, msg) {
  const domain = String((msg && msg.fromAddress) || '').toLowerCase().split('@')[1] || '';
  if (!domain) return null;
  const inst = INSTITUTIONS.find((i) => i.domains.some((d) => domain === d || domain.endsWith(`.${d}`)));
  if (!inst) return null;
  const labels = msg.labels || [];
  if (labels.includes('CATEGORY_PROMOTIONS') || labels.includes('SENT')) return null;
  if (!ACCOUNT_MAIL.test(msg.subject || '')) return null;
  if (data.accounts.some((a) => accountMatches(a, inst)) || detectSettings(data).dismissed.includes(inst.key)) return null;
  return newDetected(data, inst, { from: 'email', evidence: `an email from ${inst.name}, "${String(msg.subject).slice(0, 80)}"` });
}

/** The Gmail search for account email from the services above. */
function institutionQuery(days) {
  const from = [...new Set(INSTITUTIONS.flatMap((i) => i.domains))].map((d) => `from:${d}`).join(' OR ');
  return `newer_than:${days}d -category:promotions -in:sent -in:chats {${from}}`;
}

/* ------------------------------- subscriptions ----------------------------- */

/*
 * Services that charge again and again: streaming, music, apps, storage,
 * memberships. Each keeps its own charge history, so a receipt is either the
 * first sign of a new subscription or one more charge of one you have, and a
 * receipt read twice (from email, then from the bank export) counts once.
 */

/** The list, made if a finance.json from before subscriptions has none. */
function subsOf(data) {
  if (!Array.isArray(data.subscriptions)) data.subscriptions = [];
  return data.subscriptions;
}

/** "Netflix, Inc." and "netflix.com" are the same service. "YouTube Premium" and "YouTube TV" are not. */
function subKey(name) {
  return String(name || '').toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/\.(com|net|org|io|tv|app|co)\b/g, ' ')
    .replace(/\b(inc|llc|ltd|corp|co|the|subscription|membership|plan|monthly|annual|yearly)\b/g, ' ')
    .replace(/[^a-z0-9+]+/g, '');
}

/** The period after a date: the 31st of a month becomes the last day of a short one. */
function advanceBilling(key, frequency, times = 1) {
  const d = parseDay(key);
  if (!d) return null;
  if (frequency === 'weekly') return dayKey(addDays(d, 7 * times));
  const months = { quarterly: 3, yearly: 12 }[frequency] || 1;
  return dayKey(clampDate(d.getFullYear(), d.getMonth() + months * times, d.getDate()));
}

function subMonthly(s) {
  const a = Number(s.amount) || 0;
  return round2({ weekly: a * 52 / 12, quarterly: a / 3, yearly: a / 12 }[s.frequency] ?? a);
}

function findSubscription(data, name, id) {
  subsOf(data);
  if (id) {
    const byId = data.subscriptions.find((s) => s.id === id);
    if (byId) return byId;
  }
  const k = subKey(name);
  if (!k) return null;
  return data.subscriptions.find((s) => subKey(s.name) === k) ||
    data.subscriptions.find((s) => { const o = subKey(s.name); return o.length >= 4 && k.length >= 4 && (o.startsWith(k) || k.startsWith(o)); }) || null;
}

/** The account a card's last four digits belong to, or your only checking account for a bank payment. */
function payingAccount(data, { method, cardLast4 }) {
  const four = String(cardLast4 || '').replace(/\D/g, '').slice(-4);
  if (four.length === 4) {
    const a = data.accounts.find((x) => x.last4 === four || (x.detected && x.detected.last4 === four));
    if (a) return a;
  }
  if (method === 'bank') {
    const checking = data.accounts.filter((x) => x.type === 'checking');
    if (checking.length === 1) return checking[0];
  }
  return null;
}

/**
 * One charge on a subscription. The same charge seen twice (a receipt and the
 * bank line a few days later) is kept once. Returns 'added' or 'duplicate'.
 */
function recordCharge(sub, { date, amount, source, ref }) {
  if (!parseDay(date) || !Number.isFinite(Number(amount))) return 'invalid';
  const amt = round2(Math.abs(Number(amount)));
  sub.charges = Array.isArray(sub.charges) ? sub.charges : [];
  const twin = sub.charges.find((c) => (ref && c.ref === ref) ||
    (Math.abs(c.amount - amt) < 0.01 && Math.abs(daysBetween(c.date, date)) <= 4));
  if (twin) {
    // A bank line confirms a receipt: note both, keep the bank's date.
    if (source === 'bank' && twin.source !== 'bank') { twin.source = 'both'; twin.date = date; }
    return 'duplicate';
  }
  sub.charges.push({ date, amount: amt, source: source || 'manual', ...(ref ? { ref } : {}) });
  sub.charges.sort((a, b) => (a.date < b.date ? 1 : -1));
  if (sub.charges.length > 48) sub.charges.length = 48;

  const latest = sub.charges[0];
  if (latest.date === date) {
    if (amt > 0 && sub.amount > 0 && Math.abs(amt - sub.amount) >= 0.5) {
      sub.priceChange = { from: sub.amount, to: amt, on: date };
    }
    if (amt > 0) sub.amount = amt;
    if (!sub.nextBilling || sub.nextBilling <= date) sub.nextBilling = advanceBilling(date, sub.frequency);
    if (sub.status === 'trial' && amt > 0) { sub.status = 'active'; sub.trialConvertedOn = date; }
    if (sub.status === 'cancelled' && sub.cancelledOn && date > sub.cancelledOn) sub.chargedAfterCancel = date;
    delete sub.paymentFailedOn;
  }
  if (!sub.startedOn || date < sub.startedOn) sub.startedOn = sub.charges[sub.charges.length - 1].date;
  return 'added';
}

/**
 * What Claude read in one billing email or file, applied to Finance.
 * f: { kind, service, plan, amount, frequency, chargedOn, nextBilling, trialEnds,
 *      method, cardLast4, category, existingId, source, ref, evidence, at }
 * Returns { outcome, sub } where outcome is new, renewal, duplicate, updated,
 * cancelled, failed or ignored.
 */
function applySubscriptionFinding(data, f, now = new Date()) {
  const ignored = { outcome: 'ignored', sub: null };
  if (!f || f.kind === 'not_subscription' || !String(f.service || '').trim()) return ignored;
  const today = dayKey(now);
  const date = (d) => (parseDay(d) ? d : null);
  const amount = f.amount != null && Number.isFinite(Number(f.amount)) && Number(f.amount) >= 0 ? round2(Number(f.amount)) : null;
  const frequency = SUB_FREQUENCIES.includes(f.frequency) ? f.frequency : null;
  const method = PAY_METHODS.includes(f.method) ? f.method : null;
  const account = payingAccount(data, { method, cardLast4: f.cardLast4 });
  const at = f.at || now.toISOString();
  let sub = findSubscription(data, f.service, f.existingId);

  if (!sub) {
    if (!['charge', 'upcoming_renewal', 'trial_started', 'trial_ending', 'price_change', 'listed'].includes(f.kind)) return ignored;
    if (amount == null && !['trial_started', 'trial_ending'].includes(f.kind)) return ignored;
    if (detectSettings(data).dismissed.includes(`sub:${subKey(f.service)}`)) return ignored;
    if (data.subscriptions.length >= KINDS.subscriptions.max) return ignored;
    const trial = f.kind === 'trial_started' || f.kind === 'trial_ending' || (date(f.trialEnds) && f.trialEnds >= today);
    sub = {
      id: crypto.randomBytes(6).toString('hex'), createdAt: now.toISOString(),
      name: String(f.service).trim().slice(0, 60), plan: String(f.plan || '').slice(0, 60), amount: amount || 0,
      frequency: frequency || 'monthly', nextBilling: date(f.nextBilling), startedOn: date(f.chargedOn) || today,
      trialEnds: date(f.trialEnds), status: trial ? 'trial' : 'active', accountId: account ? account.id : '', method: method || (account && account.type === 'checking' ? 'bank' : 'card'),
      category: String(f.category || '').slice(0, 40), note: '', private: false, charges: [],
      // Something you ticked in a file you dropped is already reviewed; one from email waits for a look.
      reviewed: f.kind === 'listed' || f.source === 'file',
      detected: { from: f.source || 'email', at, evidence: String(f.evidence || '').slice(0, 160) },
    };
    data.subscriptions.push(sub);
    if (f.kind === 'charge' && date(f.chargedOn) && amount != null) recordCharge(sub, { date: f.chargedOn, amount, source: f.source || 'email', ref: f.ref });
    return { outcome: 'new', sub };
  }

  // Details a receipt knows and the subscription does not yet.
  if (f.plan && !sub.plan) sub.plan = String(f.plan).slice(0, 60);
  if (frequency && (!sub.charges || sub.charges.length < 2)) sub.frequency = frequency;
  if (account && !sub.accountId) { sub.accountId = account.id; if (method) sub.method = method; }
  if (method && !sub.accountId && !account) sub.method = method;
  if (f.category && !sub.category) sub.category = String(f.category).slice(0, 40);

  switch (f.kind) {
    case 'charge': {
      if (!date(f.chargedOn) || amount == null) return { outcome: 'ignored', sub };
      const r = recordCharge(sub, { date: f.chargedOn, amount, source: f.source || 'email', ref: f.ref });
      if (date(f.nextBilling) && f.nextBilling > f.chargedOn) sub.nextBilling = f.nextBilling;
      return { outcome: r === 'added' ? 'renewal' : 'duplicate', sub };
    }
    case 'upcoming_renewal':
    case 'listed':
    case 'price_change':
      if (date(f.nextBilling) && f.nextBilling >= today) sub.nextBilling = f.nextBilling;
      if (amount != null && amount > 0 && Math.abs(amount - sub.amount) >= 0.5) {
        if (sub.amount > 0) sub.priceChange = { from: sub.amount, to: amount, on: date(f.nextBilling) || today, upcoming: f.kind !== 'listed' };
        sub.amount = amount;
      }
      if (sub.status === 'cancelled' && f.kind === 'listed') { sub.status = 'active'; delete sub.cancelledOn; }
      return { outcome: 'updated', sub };
    case 'trial_started':
    case 'trial_ending':
      if (sub.status !== 'cancelled') sub.status = 'trial';
      if (date(f.trialEnds)) sub.trialEnds = f.trialEnds;
      if (amount != null && amount > 0) sub.amount = amount;
      return { outcome: 'updated', sub };
    case 'cancelled':
      if (sub.status !== 'cancelled') { sub.status = 'cancelled'; sub.cancelledOn = date(f.chargedOn) || today; }
      // Access usually runs to the end of what was paid for.
      if (date(f.nextBilling)) sub.endsOn = f.nextBilling;
      sub.nextBilling = null;
      return { outcome: 'cancelled', sub };
    case 'payment_failed':
      sub.paymentFailedOn = date(f.chargedOn) || today;
      return { outcome: 'failed', sub };
    default:
      return { outcome: 'ignored', sub };
  }
}

/**
 * Bank lines that are a subscription's charges: the service's name in the
 * description and about the right amount. Each is tagged, so it shows as a
 * subscription in Spending and is not also suggested as a bill.
 */
function matchSubscriptionTransactions(data, now = new Date()) {
  const subs = subsOf(data);
  if (!subs.length) return 0;
  const since = dayKey(addDays(now, -400));
  const words = subs.map((s) => {
    const first = normDesc(s.name).split(' ').filter((w) => w.length >= 3 && !/^(the|app|apple|google|amazon|com)$/.test(w))[0];
    return { s, first, key: subKey(s.name) };
  }).filter((x) => x.first || x.key.length >= 4);
  let matched = 0;
  for (const t of data.transactions) {
    if (t.date < since || t.amount >= 0 || t.fromBill || t.transferAccountId) continue;
    if (t.subscriptionId && data.subscriptions.some((s) => s.id === t.subscriptionId)) continue;
    const desc = normDesc(t.description);
    const flat = desc.replace(/ /g, '');
    const hit = words.find(({ s, first, key }) => {
      const named = (first && new RegExp(`\\b${first.replace(/[^a-z0-9]/g, '')}\\b`).test(desc)) || (key.length >= 5 && flat.includes(key));
      const amt = Math.abs(t.amount);
      return named && s.amount > 0 && Math.abs(amt - s.amount) <= Math.max(1, s.amount * 0.15);
    });
    if (!hit) continue;
    t.subscriptionId = hit.s.id;
    if (!hit.s.accountId && t.accountId && data.accounts.some((a) => a.id === t.accountId)) hit.s.accountId = t.accountId;
    if (recordCharge(hit.s, { date: t.date, amount: t.amount, source: 'bank', ref: t.id }) === 'added') matched++;
  }
  return matched;
}

/** Every subscription with what the page shows about it, and the totals. */
function subscriptionsSummary(data, now = new Date()) {
  const today = startOfDay(now);
  const todayKey = dayKey(today);
  const monthKey = todayKey.slice(0, 7);
  const yearAgo = dayKey(addDays(today, -365));
  const accountLabel = (a) => (a ? `${a.name}${a.last4 ? ` ••${a.last4}` : ''}` : '');
  const METHOD_LABELS = { card: 'Card', bank: 'Bank account', paypal: 'PayPal', apple: 'Apple', google: 'Google Play', other: 'Other' };

  const list = subsOf(data).map((s) => {
    const charges = Array.isArray(s.charges) ? s.charges : [];
    const last = charges[0] || null;
    let next = parseDay(s.nextBilling) ? s.nextBilling : last ? advanceBilling(last.date, s.frequency) : null;
    // A free trial's first charge is the day it ends.
    if (s.status === 'trial' && parseDay(s.trialEnds) && s.trialEnds >= todayKey && (!next || next < todayKey || s.trialEnds < next)) next = s.trialEnds;
    // A date that has gone by without a new receipt rolls on to the next period.
    for (let i = 0; next && next < todayKey && i < 60 && s.status !== 'cancelled' && s.status !== 'paused'; i++) next = advanceBilling(next, s.frequency);
    if (s.status === 'cancelled' || s.status === 'paused') next = null;
    const account = s.accountId ? data.accounts.find((a) => a.id === s.accountId) : null;
    const trialLeft = s.status === 'trial' && parseDay(s.trialEnds) ? Math.round((parseDay(s.trialEnds) - today) / 86400000) : null;
    return {
      ...s, charges,
      monthly: s.status === 'cancelled' || s.status === 'paused' ? 0 : subMonthly(s),
      yearly: s.status === 'cancelled' || s.status === 'paused' ? 0 : round2(subMonthly(s) * 12),
      nextCharge: next, daysUntil: next ? Math.round((parseDay(next) - today) / 86400000) : null,
      lastCharged: last ? last.date : null, lastAmount: last ? last.amount : null, chargeCount: charges.length,
      paidLast12: round2(charges.filter((c) => c.date >= yearAgo).reduce((t, c) => t + c.amount, 0)),
      paidWith: account ? { type: account.type === 'credit' ? 'card' : 'bank', label: accountLabel(account), accountId: account.id }
        : { type: s.method || 'card', label: METHOD_LABELS[s.method] || 'Card', accountId: '' },
      trialDaysLeft: trialLeft,
      needsReview: !!(s.detected && !s.reviewed),
      priceUp: !!(s.priceChange && s.priceChange.to > s.priceChange.from && daysBetween(s.priceChange.on, todayKey) <= 60),
      isNew: !!(s.detected && daysBetween(String(s.detected.at).slice(0, 10), todayKey) <= 14),
    };
  }).sort((a, b) => (a.nextCharge || '9999') < (b.nextCharge || '9999') ? -1 : (a.nextCharge || '9999') > (b.nextCharge || '9999') ? 1 : b.monthly - a.monthly);

  const live = list.filter((s) => s.status === 'active' || s.status === 'trial');
  const paying = live.filter((s) => s.status === 'active');
  const byPay = new Map();
  for (const s of paying) {
    const k = s.paidWith.accountId || `m:${s.paidWith.type}`;
    if (!byPay.has(k)) byPay.set(k, { key: k, label: s.paidWith.label, type: s.paidWith.type, accountId: s.paidWith.accountId, monthly: 0, count: 0 });
    const g = byPay.get(k);
    g.monthly = round2(g.monthly + s.monthly);
    g.count++;
  }
  const byCat = new Map();
  for (const s of paying) {
    const c = s.category || 'Other';
    byCat.set(c, round2((byCat.get(c) || 0) + s.monthly));
  }
  const soon = (n) => live.filter((s) => s.daysUntil != null && s.daysUntil <= n);
  const charges = list.flatMap((s) => s.charges.map((c) => ({ ...c, subId: s.id })));
  return {
    list,
    monthly: round2(paying.reduce((t, s) => t + s.monthly, 0)),
    yearly: round2(paying.reduce((t, s) => t + s.monthly, 0) * 12),
    activeCount: paying.length,
    trialCount: live.length - paying.length,
    trialMonthly: round2(live.filter((s) => s.status === 'trial').reduce((t, s) => t + s.monthly, 0)),
    cancelledCount: list.filter((s) => s.status === 'cancelled').length,
    reviewCount: list.filter((s) => s.needsReview).length,
    next7: { count: soon(7).length, total: round2(soon(7).reduce((t, s) => t + (s.status === 'trial' ? 0 : s.amount), 0)) },
    next30: { count: soon(30).length, total: round2(soon(30).reduce((t, s) => t + (s.status === 'trial' ? 0 : s.amount), 0)) },
    chargedThisMonth: round2(charges.filter((c) => c.date.slice(0, 7) === monthKey).reduce((t, c) => t + c.amount, 0)),
    paidLast12: round2(charges.filter((c) => c.date >= yearAgo).reduce((t, c) => t + c.amount, 0)),
    byPayment: [...byPay.values()].sort((a, b) => b.monthly - a.monthly),
    byCategory: [...byCat.entries()].map(([category, monthly]) => ({ category, monthly })).sort((a, b) => b.monthly - a.monthly),
    upcoming: live.filter((s) => s.daysUntil != null && s.daysUntil <= 35)
      .map((s) => ({ subId: s.id, name: s.name, amount: s.amount, date: s.nextCharge, daysAway: s.daysUntil, trial: s.status === 'trial', paidWith: s.paidWith.label, private: !!s.private })),
  };
}

// Charges that are subscriptions by name, for suggesting one from the bank export.
const KNOWN_SUBS = /\b(netflix|spotify|hulu|disney|hbo|max\.com|paramount|peacock|crunchyroll|youtube|apple\.com\/bill|itunes|icloud|audible|kindle unlimited|prime video|amazon prime|adobe|microsoft|xbox|playstation|nintendo|openai|chatgpt|anthropic|claude|midjourney|dropbox|google (one|storage)|notion|canva|grammarly|duolingo|headspace|calm|peloton|planet fitness|la fitness|crunch fitness|equinox|strava|patreon|twitch|discord|nytimes|new york times|wsj|wall street journal|washington post|substack|siriusxm|pandora|tidal|linkedin|chegg|quizlet|coursera|masterclass|nordvpn|expressvpn|1password|lastpass|github|squarespace|wix|godaddy|uber one|dashpass|doordash dashpass|instacart\+|walmart\+|costco|sam'?s club)\b/i;

const STALE_DAYS = 7;

/** Charges that come back: the same payee and amount in three of the last four months, or most weeks. */
function recurringCharges(data, now = new Date()) {
  const since = dayKey(addDays(now, -125));
  const groups = new Map();
  for (const t of data.transactions) {
    // Small change (interest, in-game purchases) is not worth a bill.
    if (t.date < since || t.fromBill || t.transferAccountId || t.subscriptionId || t.pending || Math.abs(t.amount) < 5) continue;
    const name = normDesc(t.description);
    if (!name) continue;
    const k = `${name}|${Math.round(t.amount)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = [];
  for (const list of groups.values()) {
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
    const last = list[list.length - 1];
    const months = new Set(list.map((t) => t.date.slice(0, 7)));
    const gaps = list.slice(1).map((t, i) => daysBetween(list[i].date, t.date)).sort((a, b) => a - b);
    const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    let frequency = null;
    if (list.length >= 5 && gap >= 6 && gap <= 8) frequency = 'weekly';
    else if (list.length >= 4 && gap >= 13 && gap <= 15) frequency = 'biweekly';
    else if (months.size >= 3 && list.length <= months.size + 1 && gap >= 25) frequency = 'monthly';
    if (!frequency) continue;
    // Stopped: nothing for longer than two of its gaps.
    const stale = { weekly: 16, biweekly: 30, monthly: 45 }[frequency];
    if (daysBetween(last.date, dayKey(now)) > stale) continue;
    const step = { weekly: 7, biweekly: 14, monthly: null }[frequency];
    let next = parseDay(last.date);
    const today = startOfDay(now);
    while (next <= today) next = step ? addDays(next, step) : clampDate(next.getFullYear(), next.getMonth() + 1, parseDay(last.date).getDate());
    out.push({
      name: last.description.replace(/^(sign debit|recurring payment|p debit|debit)\s+/i, '').slice(0, 60),
      key: normDesc(last.description), amount: round2(Math.abs(last.amount)), income: last.amount > 0, frequency,
      count: list.length, nextDate: dayKey(next), category: last.category || '',
    });
  }
  return out.sort((a, b) => monthlyEquivalent(b) - monthlyEquivalent(a));
}

function spendingByCategory(data, now, days) {
  const since = dayKey(addDays(now, -days));
  const by = new Map();
  for (const t of data.transactions) {
    if (t.date < since || t.amount >= 0 || t.transferAccountId || /^transfer$/i.test(t.category || '')) continue;
    const c = t.category || 'Uncategorised';
    by.set(c, (by.get(c) || 0) - t.amount);
  }
  return [...by.entries()].map(([category, amount]) => ({ category, perMonth: round2(amount * 30 / days) })).sort((a, b) => b.perMonth - a.perMonth);
}

const shortDay = (k) => { const d = parseDay(k); return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : k; };
const money = (n) => `$${Number(n).toFixed(2)}`;

/**
 * Everything the Finance page is missing or has let go stale, one item each,
 * most important first. Each clears by itself once the thing is filled in.
 * `go` says where on the page to fix it.
 */
function setupItems(data, now = new Date()) {
  const out = [];
  const add = (id, title, why, go, rank) => out.push({ id: `fin-setup:${id}`, title, why, go, rank });
  const today = dayKey(now);

  const investing = (a) => a.type === 'investment' || a.type === 'retirement';
  for (const a of data.accounts) {
    const card = a.type === 'credit';
    const go = { kind: 'accounts', id: a.id, card };
    if (a.balance == null) {
      const found = a.detected
        ? `Found in ${a.detected.from === 'email' ? 'your email' : a.detected.from === 'import' ? 'your files' : 'your transactions'}: ${a.detected.evidence}. `
        : '';
      const bare = investing(a) && !data.holdings.some((h) => h.accountId === a.id);
      add(`balance:${a.id}`, bare ? `Fill in ${a.name}: cash and holdings` : `Enter your ${a.name} balance`,
        `${found}${a.detected && a.detected.how ? a.detected.how : 'Until it has a balance, it is left out of your net worth.'}`, go, 1);
      continue;
    }
    const age = a.updatedAt ? Math.floor((now - new Date(a.updatedAt)) / 86400000) : 0;
    if (age >= STALE_DAYS) add(`refresh:${a.id}:${String(a.updatedAt).slice(0, 10)}`, `Update your ${a.name} balance`, `Last updated ${age} days ago.`, go, 2);
    if (card) {
      const missing = [['creditLimit', 'credit limit'], ['dueDay', 'payment due day'], ['statementBalance', 'statement balance'], ['apr', 'APR']]
        .filter(([f]) => a[f] == null).map(([, l]) => l);
      if (missing.length) add(`card:${a.id}`, `Finish the ${a.name} details`, `Still missing: ${missing.join(', ')}.`, go, 2);
    }
  }

  const banked = data.transactions.filter((t) => !t.fromBill);
  if (!banked.length) {
    add('import', 'Import your bank transactions', 'Download a CSV of transactions from your bank\'s website and drop it on Finance. It is read on this PC and never sent anywhere.', { scan: true }, 1);
  } else if (daysBetween(banked[0].date, today) >= 14) {
    add(`import:${banked[0].date}`, 'Import your latest bank transactions', `The newest one in Finance is from ${shortDay(banked[0].date)}. Download a fresh CSV from your bank and drop it on Finance; rows already there are skipped.`, { scan: true }, 2);
  }

  /* subscriptions: new ones to look at, trials about to charge, money taken after cancelling */
  const subs = subscriptionsSummary(data, now).list;
  for (const s of subs) {
    const go = { kind: 'subscriptions', id: s.id };
    const per = { weekly: 'a week', monthly: 'a month', quarterly: 'every 3 months', yearly: 'a year' }[s.frequency] || 'a month';
    if (s.chargedAfterCancel) {
      add(`sub-after-cancel:${s.id}:${s.chargedAfterCancel}`, `${s.name} charged you after you cancelled`, `A ${money(s.lastAmount || s.amount)} charge on ${shortDay(s.chargedAfterCancel)}, after you cancelled on ${shortDay(s.cancelledOn)}. Ask them for a refund, and check the cancellation went through.`, go, 1);
    }
    if (s.paymentFailedOn && s.status !== 'cancelled') {
      add(`sub-failed:${s.id}:${s.paymentFailedOn}`, `${s.name} couldn't charge you`, `A payment failed on ${shortDay(s.paymentFailedOn)}. Update the card with them, or cancel it if you don't use it.`, go, 1);
    }
    if (s.status === 'trial' && s.trialDaysLeft != null && s.trialDaysLeft >= 0 && s.trialDaysLeft <= 3) {
      add(`sub-trial:${s.id}:${s.trialEnds}`, `${s.name} free trial ends ${s.trialDaysLeft === 0 ? 'today' : s.trialDaysLeft === 1 ? 'tomorrow' : shortDay(s.trialEnds)}`,
        `After that it charges ${s.amount ? `${money(s.amount)} ${per}` : 'you'}. Cancel before then if you don't want to keep it.`, go, 1);
    }
    if (s.needsReview) {
      add(`sub-review:${s.id}`, `New subscription found: ${s.name}${s.amount ? ` (${money(s.amount)} ${per})` : ''}`,
        `${s.detected.from === 'email' ? 'Found in your email' : 'Found in a file'}${s.lastCharged ? `, charged ${shortDay(s.lastCharged)}` : ''}${s.paidWith.accountId ? ` to ${s.paidWith.label}` : ''}. Check it's right, or remove it if it isn't yours.`,
        { ...go, review: true }, 2);
    }
  }

  const subName = (key) => data.subscriptions.some((s) => { const k = subKey(s.name); return k.length >= 4 && key.replace(/ /g, '').includes(k); });
  const rec = recurringCharges(data, now).filter((r) => !subName(r.key) && !data.bills.some((b) => {
    const n = normDesc(b.name);
    return n && (n.includes(r.key) || r.key.includes(n) || n.split(' ')[0] === r.key.split(' ')[0]);
  }));
  for (const r of rec.filter((x) => !x.income && KNOWN_SUBS.test(x.name)).slice(0, 5)) {
    add(`sub-suggest:${r.key.replace(/ /g, '-')}`, `Add ${r.name} as a subscription (${money(r.amount)} ${r.frequency === 'weekly' ? 'a week' : 'a month'})`,
      `It has charged you ${r.count} times lately. As a subscription it's counted in what you pay each month, and you'll see it coming; next about ${shortDay(r.nextDate)}.`,
      { kind: 'subscriptions', prefill: { name: r.name, amount: r.amount, frequency: r.frequency === 'weekly' ? 'weekly' : 'monthly', nextBilling: r.nextDate, category: r.category || 'Subscriptions' } }, 3);
  }
  for (const r of rec.filter((x) => x.income || !KNOWN_SUBS.test(x.name)).slice(0, 5)) {
    const freq = { weekly: 'a week', biweekly: 'every two weeks', monthly: 'a month' }[r.frequency];
    add(`bill:${r.key.replace(/ /g, '-')}`, `Add ${r.name} (${money(r.amount)} ${freq}) as ${r.income ? 'a payday' : 'a bill'}`,
      `It has ${r.income ? 'come in' : 'gone out'} ${r.count} times lately. As ${r.income ? 'a payday' : 'a bill'} it shows up before it is due; next about ${shortDay(r.nextDate)}.`,
      { kind: 'bills', prefill: { name: r.name, amount: r.amount, dueDate: r.nextDate, frequency: r.frequency, income: r.income, category: r.income ? 'Income' : (r.category || 'Bills') } }, 3);
  }
  if (!data.bills.length && !rec.length) {
    add('bills', 'Add your bills and paydays', 'Rent, phone, subscriptions, and money coming in, so Finance can tell you what is due this week.', { kind: 'bills' }, 3);
  }

  if (!data.budgets.length) {
    const top = spendingByCategory(data, now, 90).slice(0, 3);
    add('budgets', 'Set monthly budgets', top.length
      ? `Over the last three months you have spent most on ${top.map((c) => `${c.category} (about ${money(c.perMonth)} a month)`).join(', ')}.`
      : 'A monthly limit for the things you spend most on.', { kind: 'budgets', prefill: top[0] ? { category: top[0].category, monthly: Math.ceil(top[0].perMonth / 10) * 10 } : null }, 3);
  }

  for (const a of data.accounts) {
    if (investing(a) && a.balance != null && !data.holdings.some((h) => h.accountId === a.id)) {
      add(`holdings:${a.id}`, `Add what you hold in ${a.name}`, (a.detected && a.detected.how) || 'Add each position under Holdings, or drop a positions CSV exported from the account on Finance.', { kind: 'holdings', accountId: a.id }, 2);
    }
  }
  const noBasis = data.holdings.filter((h) => h.costBasis == null);
  if (noBasis.length) {
    const syms = noBasis.map((h) => h.symbol);
    add(`basis:${syms.slice().sort().join(',')}`, `Add what you paid for ${syms.slice(0, 3).join(', ')}${syms.length > 3 ? ` and ${syms.length - 3} more` : ''}`, 'With the total you paid, Finance can show your gain or loss.', { kind: 'holdings', id: noBasis[0].id }, 4);
  }

  if (!data.goals.length) add('goals', 'Set a savings goal', 'Something to put money toward: a trip, an emergency fund, a laptop. Finance works out how much a month it takes.', { kind: 'goals' }, 4);

  return out.sort((a, b) => a.rank - b.rank);
}

/** Sunday at 8 PM, at least two days after it first appeared: the same evening as the weekly finance check. */
function setupDue(firstSeen) {
  const seen = new Date(firstSeen);
  let d = addDays(startOfDay(seen), 2);
  while (d.getDay() !== 0) d = addDays(d, 1);
  d.setHours(20, 0, 0, 0);
  return d.toISOString();
}

let setupCache = { mtime: -1, day: '', items: [] };

/**
 * The missing pieces as tasks for the scheduler. They only nudge, never
 * block, and each disappears once the thing it asks for is filled in.
 * Read from finance.json only when it changes, since this runs on every poll.
 */
function setupTasks(now = new Date()) {
  let mtime;
  try { mtime = fs.statSync(DATA_FILE).mtimeMs; } catch (_) { return []; }
  const day = dayKey(now);
  if (setupCache.mtime !== mtime || setupCache.day !== day) {
    const data = load();
    const items = setupItems(data, now);
    const seen = data.settings.setupSeen && typeof data.settings.setupSeen === 'object' ? data.settings.setupSeen : {};
    const next = {};
    for (const it of items) next[it.id] = seen[it.id] || now.toISOString();
    if (JSON.stringify(next) !== JSON.stringify(seen)) {
      data.settings.setupSeen = next;
      try { save(data); mtime = fs.statSync(DATA_FILE).mtimeMs; } catch (_) {}
    }
    setupCache = { mtime, day, items: items.map((it) => ({ ...it, firstSeen: next[it.id] })) };
  }
  return setupCache.items.map((it) => ({
    id: it.id,
    title: it.title,
    group: 'finance',
    kind: 'finance',
    auto: true,
    confirmed: false,
    clearedBy: it.why,
    cadence: { type: 'once', dueAt: setupDue(it.firstSeen) },
    escalation: [{ afterMinutes: 0, level: 'nudge' }],
    source: { type: 'finance' },
    go: it.go,
  }));
}

/** Which parts of the Finance page Claude may read. Only known switches, only true or false. */
function setAiShare(data, patch) {
  const next = { ...privacy.shareSettings(data) };
  for (const k of Object.keys(privacy.DEFAULT_SHARE)) if (typeof (patch || {})[k] === 'boolean') next[k] = patch[k];
  data.settings = { ...data.settings, ai: next };
  return next;
}

/** How the last look through email for subscriptions went. Counts only, never what was found. */
function setSubscriptionScan(data, patch) {
  const prev = data.settings.subscriptionScan && typeof data.settings.subscriptionScan === 'object' ? data.settings.subscriptionScan : {};
  const { read = 0, new: found = 0, renewals = 0, ...rest } = patch || {};
  const t = prev.totals || {};
  data.settings.subscriptionScan = {
    ...prev, ...rest,
    totals: { read: (t.read || 0) + read, new: (t.new || 0) + found, renewals: (t.renewals || 0) + renewals },
  };
  return data.settings.subscriptionScan;
}

/* --------------------------------- summary ------------------------------- */

async function holdingsWithPrices(data) {
  const symbols = data.holdings.map((h) => h.symbol);
  const { quotes } = symbols.length ? await stocks.getQuotes(symbols, 5) : { quotes: {} };
  const names = stocks.loadSettings().names || {};
  return data.holdings.map((h) => {
    const q = quotes[h.symbol];
    const price = q ? q.price : null;
    const value = price != null ? round2(price * h.shares) : null;
    return {
      ...h,
      name: names[h.symbol] || (q ? q.name : h.symbol),
      price,
      value,
      dayChange: q && q.change != null ? round2(q.change * h.shares) : null,
      dayChangePercent: q ? q.changePercent : null,
      gain: value != null && h.costBasis ? round2(value - h.costBasis) : null,
      gainPercent: value != null && h.costBasis ? ((value - h.costBasis) / h.costBasis) * 100 : null,
      session: q ? q.session : null,
      asOf: q ? q.asOf : null,
      spark: q ? q.spark : [],
    };
  });
}

function totals(data, holdings) {
  const held = new Map();
  let looseHoldings = 0;
  for (const h of holdings) {
    if (h.value == null) continue;
    if (h.accountId && data.accounts.some((a) => a.id === h.accountId)) held.set(h.accountId, (held.get(h.accountId) || 0) + h.value);
    else looseHoldings += h.value;
  }
  let cash = 0, invested = looseHoldings, debt = 0, other = 0;
  const accounts = data.accounts.map((a) => {
    // An investment account's balance is its uninvested cash; the shares
    // listed under it are added at today's price.
    // A balance nobody has entered yet counts for nothing, and says so.
    const value = round2((a.balance == null ? 0 : Number(a.balance) || 0) + (held.get(a.id) || 0));
    if (DEBT_TYPES.includes(a.type)) debt += Math.abs(value);
    else if (CASH_TYPES.includes(a.type)) cash += value;
    else if (a.type === 'investment' || a.type === 'retirement') invested += value;
    else other += value;
    return { ...a, value, holdingsValue: round2(held.get(a.id) || 0), balanceMissing: a.balance == null };
  });
  const assets = cash + invested + other;
  return {
    accounts,
    cash: round2(cash), invested: round2(invested), other: round2(other), debt: round2(debt),
    assets: round2(assets), netWorth: round2(assets - debt),
  };
}

/** Today's figures into the history, one entry per day, the latest winning. */
function snapshot(data, t) {
  if (!data.accounts.length && !data.holdings.length) return;
  const key = dayKey(new Date());
  const entry = { day: key, netWorth: t.netWorth, assets: t.assets, debt: t.debt, cash: t.cash, invested: t.invested };
  const last = data.history[data.history.length - 1];
  if (last && last.day === key) data.history[data.history.length - 1] = entry;
  else data.history.push(entry);
  if (data.history.length > 1000) data.history.splice(0, data.history.length - 1000);
}

function changeSince(history, days, current) {
  const cutoff = dayKey(addDays(new Date(), -days));
  let best = null;
  for (const h of history) if (h.day <= cutoff) best = h;
  return best ? { from: best.day, amount: round2(current - best.netWorth) } : null;
}

async function summary(data) {
  const now = new Date();
  const today = startOfDay(now);
  const holdings = await holdingsWithPrices(data);
  const t = totals(data, holdings);

  // Spending this month, by category, against the budgets.
  const monthKey = dayKey(today).slice(0, 7);
  const lastMonthKey = dayKey(new Date(today.getFullYear(), today.getMonth() - 1, 1)).slice(0, 7);
  const byCat = new Map();
  let spent = 0, income = 0, spentLastMonthToDate = 0;
  for (const x of data.transactions) {
    // Money moved into an account of your own is not spending, nor income coming back.
    if (x.transferAccountId) continue;
    if (x.date.slice(0, 7) === monthKey) {
      if (x.amount < 0) {
        spent += -x.amount;
        const c = x.category || 'Uncategorised';
        byCat.set(c, (byCat.get(c) || 0) - x.amount);
      } else income += x.amount;
    } else if (x.date.slice(0, 7) === lastMonthKey && x.amount < 0 && +x.date.slice(8) <= today.getDate()) {
      spentLastMonthToDate += -x.amount;
    }
  }
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const monthShare = today.getDate() / daysInMonth;
  const budgets = data.budgets.map((b) => {
    const used = round2([...byCat.entries()].filter(([c]) => c.toLowerCase() === b.category.toLowerCase()).reduce((s, [, v]) => s + v, 0));
    const pct = b.monthly ? (used / b.monthly) * 100 : (used ? 100 : 0);
    // Ahead of pace means spending faster than the month is passing.
    const status = used > b.monthly ? 'over' : pct >= 85 ? 'near' : pct > monthShare * 100 + 15 ? 'fast' : 'ok';
    return { ...b, spent: used, left: round2(b.monthly - used), percent: pct, status };
  });
  const categories = [...byCat.entries()].map(([category, amount]) => ({ category, amount: round2(amount) }))
    .sort((a, b) => b.amount - a.amount);

  // Bills: anything still open from the last six weeks, and the next month.
  const upcoming = [];
  for (const b of data.bills) {
    for (const d of occurrences(b, addDays(today, -45), addDays(today, 35))) {
      const key = dayKey(d);
      const paid = (b.paid || []).includes(key);
      const daysAway = Math.round((d - today) / 86400000);
      if (paid && daysAway < -1) continue;
      // Autopay takes care of itself once the day has passed.
      if (b.autopay && daysAway < 0) continue;
      upcoming.push({
        billId: b.id, cardId: b.cardId || null, private: !!b.private,
        name: b.name, amount: b.amount, income: !!b.income, autopay: !!b.autopay, category: b.category || '',
        frequency: b.frequency, date: key, daysAway, paid, overdue: !paid && daysAway < 0,
      });
    }
  }
  upcoming.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const billsIn = (n) => upcoming.filter((u) => !u.paid && !u.income && u.daysAway <= n);
  const due7 = billsIn(7);

  const goals = data.goals.map((g) => {
    const by = parseDay(g.by);
    const monthsLeft = by ? Math.max(0, (by.getFullYear() - today.getFullYear()) * 12 + by.getMonth() - today.getMonth()) : null;
    const left = Math.max(0, g.target - (g.saved || 0));
    return {
      ...g, saved: g.saved || 0, percent: Math.min(100, ((g.saved || 0) / g.target) * 100), left: round2(left),
      perMonth: monthsLeft ? round2(left / monthsLeft) : null, done: left <= 0,
    };
  });

  const cards = data.accounts.filter((a) => a.type === 'credit').map((a) => cardSummary(a, upcoming, today));
  const limits = cards.filter((c) => c.creditLimit);
  const cardTotals = {
    balance: round2(cards.reduce((sum, c) => sum + c.balance, 0)),
    limit: round2(limits.reduce((sum, c) => sum + c.creditLimit, 0)),
    utilization: limits.length ? (limits.reduce((sum, c) => sum + c.balance, 0) / limits.reduce((sum, c) => sum + c.creditLimit, 0)) * 100 : null,
    monthlyInterestIfCarried: round2(cards.reduce((sum, c) => sum + (c.monthlyInterestIfCarried || 0), 0)),
  };

  return {
    ...t,
    cards,
    cardTotals,
    holdings,
    holdingsValue: round2(holdings.reduce((s, h) => s + (h.value || 0), 0)),
    holdingsDayChange: round2(holdings.reduce((s, h) => s + (h.dayChange || 0), 0)),
    change7: changeSince(data.history, 7, t.netWorth),
    change30: changeSince(data.history, 30, t.netWorth),
    history: data.history.slice(-120).map((h) => ({ day: h.day, netWorth: h.netWorth })),
    month: {
      key: monthKey, spent: round2(spent), income: round2(income), net: round2(income - spent),
      spentLastMonthToDate: round2(spentLastMonthToDate), categories,
      budgeted: round2(data.budgets.reduce((s, b) => s + b.monthly, 0)), dayOfMonth: today.getDate(), daysInMonth,
    },
    budgets,
    upcoming,
    dueThisWeek: { count: due7.length, total: round2(due7.reduce((s, u) => s + u.amount, 0)) },
    overdue: upcoming.filter((u) => u.overdue && !u.income),
    monthlyBills: round2(data.bills.filter((b) => !b.income).reduce((s, b) => s + monthlyEquivalent(b), 0)),
    monthlyIncome: round2(data.bills.filter((b) => b.income).reduce((s, b) => s + monthlyEquivalent(b), 0)),
    goals,
    subscriptions: subscriptionsSummary(data, now),
  };
}

/** Everything the Finance page needs in one answer. */
async function getFinance() {
  const data = load();
  const s = await summary(data);
  // The first look of the day starts that day's point on the net worth line,
  // so it keeps moving on days nothing is edited. Later looks do not write:
  // edits and the morning timer keep it current.
  const last = data.history[data.history.length - 1];
  if (!last || last.day !== dayKey(new Date())) {
    snapshot(data, s);
    try { save(data); } catch (_) {}
  }
  return {
    settings: { morningHour: data.settings.morningHour, ai: privacy.shareSettings(data), subscriptionScan: data.settings.subscriptionScan || null },
    aiLabels: privacy.SHARE_LABELS,
    accountTypes: ACCOUNT_TYPES,
    frequencies: FREQUENCIES,
    subFrequencies: SUB_FREQUENCIES,
    subStatuses: SUB_STATUSES,
    payMethods: PAY_METHODS,
    subscriptions: data.subscriptions,
    accounts: data.accounts,
    bills: data.bills,
    budgets: data.budgets,
    goals: data.goals,
    holdings: data.holdings,
    transactions: data.transactions.slice(0, 300),
    transactionCount: data.transactions.length,
    setup: setupItems(data),
    staleDays: STALE_DAYS,
    categories: [...new Set([...data.budgets.map((b) => b.category), ...data.transactions.map((t) => t.category).filter(Boolean)])].sort(),
    summary: s,
  };
}

/** Run a change against the file and record the day's snapshot with it. */
async function change(fn) {
  const data = load();
  const result = fn(data);
  // A transaction typed in by hand can point to an account too, or be a subscription's charge.
  try { detectAccounts(data); } catch (_) {}
  try { matchSubscriptionTransactions(data); } catch (_) {}
  save(data);
  try {
    const s = await summary(data);
    snapshot(data, s);
    save(data);
  } catch (_) {}
  return result;
}

/* ------------------------------ morning brief ---------------------------- */

function cleanName(name, symbol) {
  const n = String(name || '')
    .replace(/,?\s+(inc|corp|corporation|co|company|plc|ltd|limited|holdings?|group|sa|nv|ag|se|class [a-z]|adr)\.?$/gi, '')
    .replace(/,?\s+(inc|corp|plc|ltd)\.?$/gi, '')
    .replace(/[^\w .&'-]/g, '').trim();
  return n && n.toUpperCase() !== symbol ? n : '';
}

function gnewsSearch(q) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
}

function trimStory(s) {
  return {
    title: s.title, outlet: s.outlet || '', link: s.link, publishedAt: s.publishedAt || null,
    summary: String(s.summary || '').slice(0, 220),
  };
}

/** Recent, and not the same headline twice across the brief. */
function pick(stories, n, seen, maxAgeHours = 48) {
  const out = [];
  const cutoff = Date.now() - maxAgeHours * 3600000;
  for (const s of stories) {
    if (out.length >= n) break;
    if (s.publishedAt && new Date(s.publishedAt).getTime() < cutoff) continue;
    const k = String(s.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
    if (seen.has(k) || seen.has(s.link)) continue;
    seen.add(k); seen.add(s.link);
    out.push(trimStory(s));
  }
  return out;
}

/** The stocks you hold and the ones you follow on the News page, with names. */
function followedSymbols(data) {
  const stockSettings = stocks.loadSettings();
  const list = [];
  const add = (symbol, name) => {
    if (!symbol || list.some((x) => x.symbol === symbol)) return;
    list.push({ symbol, name: name || '' });
  };
  data.holdings.forEach((h) => add(h.symbol, stockSettings.names[h.symbol]));
  stockSettings.symbols.forEach((s) => add(s, stockSettings.names[s]));
  return list.slice(0, 20);
}

/* What a crypto pair is called in the news: "BTC-USD" is written about as Bitcoin. */
const CRYPTO_NAMES = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', USDC: 'USDC stablecoin', USDT: 'Tether', HYPE: 'Hyperliquid', DOGE: 'Dogecoin', XRP: 'XRP', ADA: 'Cardano', AVAX: 'Avalanche', LINK: 'Chainlink', BNB: 'BNB' };
function cryptoName(symbol) {
  const m = /^([A-Z0-9]+)-USD$/.exec(symbol || '');
  return m ? CRYPTO_NAMES[m[1]] || m[1] : null;
}

let building = null;

async function buildBrief(opts = {}) {
  if (building) return building;
  building = (async () => {
    const data = load();
    const settings = data.settings;
    const force = !!opts.force;
    const followed = followedSymbols(data);
    const { quotes } = await stocks.getQuotes(followed.map((f) => f.symbol), 5);

    const feeds = await Promise.all([
      news.feedStories('fin-business', 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en', { force, maxStories: 30 }),
      news.feedStories('fin-wsj-markets', 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain', { force, maxStories: 20 }),
      // The query is part of the cache name, so editing it in finance.json takes effect at once.
      news.feedStories(`fin-money-${crypto.createHash('sha1').update(String(settings.moneyQuery)).digest('hex').slice(0, 8)}`,
        gnewsSearch(`${settings.moneyQuery} when:1d`), { force, maxStories: 20 }),
      ...followed.map((f) => {
        const coin = cryptoName(f.symbol);
        const name = coin || cleanName(f.name || (quotes[f.symbol] || {}).name, f.symbol);
        const q = coin ? `"${coin}" (price OR crypto) when:3d`
          : name ? `"${name}" (stock OR shares OR earnings) when:3d` : `${f.symbol} stock when:3d`;
        return news.feedStories(`fin-sym-${f.symbol}`, gnewsSearch(q), { force, maxStories: 10 });
      }),
    ]);

    const seen = new Set();
    const count = Math.min(15, Math.max(3, Number(settings.headlineCount) || 8));
    // The stocks' own stories are picked first, so a headline about Nike is
    // filed under Nike rather than under business in general.
    const yourStocks = followed.map((f, i) => ({
      symbol: f.symbol,
      name: f.name || (quotes[f.symbol] || {}).name || f.symbol,
      held: data.holdings.some((h) => h.symbol === f.symbol),
      stories: pick(feeds[3 + i].stories, 3, seen, 96),
    }));
    const markets = pick(feeds[1].stories, 5, seen, 36);
    const business = pick(feeds[0].stories, count, seen, 36);
    const money = pick(feeds[2].stories, 5, seen, 48);

    const errors = feeds.map((f) => f.error).filter(Boolean);
    const brief = {
      day: dayKey(new Date()),
      builtAt: new Date().toISOString(),
      business,
      markets,
      money,
      yourStocks,
      error: errors.length === feeds.length ? errors[0] : null,
    };
    try { writeJson(BRIEF_FILE, brief); } catch (_) {}
    return brief;
  })().finally(() => { building = null; });
  return building;
}

/**
 * Today's brief. Built the first time it is asked for after morningHour, or
 * by the engine's morning timer, whichever comes first. Before morningHour it
 * is yesterday's, which is what you would want to read at midnight anyway.
 * Market prices are always live; only the headlines are the morning's.
 */
async function getBrief(opts = {}) {
  const data = load();
  const settings = data.settings;
  const now = new Date();
  let brief = readJson(BRIEF_FILE, null);
  const ageMin = brief && brief.builtAt ? (Date.now() - new Date(brief.builtAt).getTime()) / 60000 : Infinity;
  const due = !brief || (brief.day !== dayKey(now) && now.getHours() >= settings.morningHour);
  if (due || (opts.force && ageMin > 2)) {
    brief = await buildBrief({ force: !!opts.force || due });
  }

  const marketList = (settings.markets || []).filter((m) => m && m.symbol).slice(0, 10);
  const followed = (brief && brief.yourStocks) || [];
  const { quotes } = await stocks.getQuotes([...marketList.map((m) => m.symbol), ...followed.map((f) => f.symbol)], 5);
  const quote = (symbol, name) => {
    const q = quotes[symbol];
    if (!q) return { symbol, name: name || symbol, missing: true };
    return {
      symbol, name: name || q.name, price: q.price, change: q.change, changePercent: q.changePercent,
      session: q.session, asOf: q.asOf, spark: q.spark, currency: q.currency,
    };
  };

  return {
    ...(brief || { business: [], markets: [], money: [], yourStocks: [] }),
    morningHour: settings.morningHour,
    indices: marketList.map((m) => quote(m.symbol, m.name)),
    yourStocks: followed.map((f) => ({ ...f, quote: quote(f.symbol, f.name) })),
  };
}

/** Called by the engine every few minutes: builds the brief once each morning. */
async function morningTick(log) {
  const data = load();
  const now = new Date();
  if (now.getHours() < data.settings.morningHour) return;
  const brief = readJson(BRIEF_FILE, null);
  if (brief && brief.day === dayKey(now)) return;
  const built = await buildBrief({ force: true });
  if (log) log(`finance: morning brief built (${built.business.length} headlines, ${built.yourStocks.length} stocks)`);
  try {
    const s = await summary(data);
    snapshot(data, s);
    save(data);
  } catch (_) {}
}

module.exports = {
  load, save, upsert, remove, markPaid, unmarkPaid, setAiShare, syncCardBill, CARD_AUTOPAY, occurrences, monthlyEquivalent, totals, summary,
  getFinance, change, getBrief, buildBrief, morningTick, cleanName,
  importTransactions, importHoldings, detectAccounts, detectFromEmail, institutionQuery, normDesc,
  recurringCharges, setupItems, setupTasks, setupDue,
  subKey, advanceBilling, findSubscription, recordCharge, applySubscriptionFinding, matchSubscriptionTransactions, subscriptionsSummary, setSubscriptionScan,
  KINDS, ACCOUNT_TYPES, FREQUENCIES, SUB_FREQUENCIES, SUB_STATUSES, PAY_METHODS, INSTITUTIONS, STALE_DAYS, DATA_FILE, BRIEF_FILE,
};
