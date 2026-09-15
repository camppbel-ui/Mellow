'use strict';
/**
 * privacy.js - what leaves this PC for Claude, and what does not.
 *
 * Two layers, both applied by the callers in lib/ai, never left to the model:
 *
 *   1. redact(): every piece of text Mellow itself sends has card numbers,
 *      Social Security numbers and bank account or routing numbers masked
 *      first. A PDF or photo you drop is sent as the file itself and cannot be
 *      masked, which is why finance documents need their own switch.
 *
 *   2. financeForAi(): the Finance page decides, part by part, what Claude may
 *      see. Anything not switched on in finance.json's `ai` block is left out
 *      entirely rather than summarised, and any single item marked private is
 *      left out whatever the switches say.
 */

const DEFAULT_SHARE = {
  bills: true,          // names, amounts, due dates of bills and paydays
  budgets: true,        // monthly limits and how much of each is spent
  goals: true,          // savings goals and progress
  subscriptions: true,  // services you pay for again and again: names, prices, next charge
  holdings: false,      // which stocks you own and their value
  accounts: false,      // account names, types and balances
  cards: false,         // credit cards: balances, limits, APR, due dates
  transactions: false,  // individual purchases and where they were made
  netWorth: false,      // the totals
  statements: false,    // may a dropped bank or card statement (PDF, photo) be read by Claude
  receipts: true,       // may receipt and renewal emails be read by Claude to find subscriptions
};

// Switches that say what Claude may read, rather than what the assistant is told.
const READ_SWITCHES = new Set(['statements', 'receipts']);

const SHARE_LABELS = {
  bills: 'Bills and paydays',
  budgets: 'Budgets and spending by category',
  goals: 'Savings goals',
  subscriptions: 'Subscriptions',
  holdings: 'Stocks you hold',
  accounts: 'Accounts and balances',
  cards: 'Credit cards',
  transactions: 'Individual transactions',
  netWorth: 'Net worth and totals',
  statements: 'Read dropped statements (PDFs and photos of them)',
  receipts: 'Find subscriptions in your email (receipts and renewals are read by Claude)',
};

function shareSettings(financeData) {
  const raw = (financeData && financeData.settings && financeData.settings.ai) || {};
  const out = { ...DEFAULT_SHARE };
  for (const k of Object.keys(DEFAULT_SHARE)) if (typeof raw[k] === 'boolean') out[k] = raw[k];
  return out;
}

/* -------------------------------- redaction ------------------------------ */

function luhnOk(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

/**
 * Masks what should never reach a model, keeping just enough to stay useful:
 * a card keeps its last four so "the card ending 4242" still makes sense.
 */
function redact(text) {
  let s = String(text == null ? '' : text);
  // Card numbers: 13 to 19 digits, optionally grouped by spaces or dashes, Luhn-valid.
  s = s.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhnOk(digits)) return m;
    return `[card ending ${digits.slice(-4)}]`;
  });
  // US Social Security numbers.
  s = s.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN removed]');
  // Account and routing numbers, when labelled as such.
  s = s.replace(/\b((?:account|acct|routing|aba|iban|member)\s*(?:number|no\.?|#)?\s*[:#]?\s*)([A-Z]{0,4}[\d][\d -]{4,30}\d)/gi,
    (m, label, num) => `${label}[number ending ${num.replace(/\D/g, '').slice(-4)}]`);
  return s;
}

/** Redacts every string inside a JSON-able value. */
function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

/* --------------------------------- finance ------------------------------- */

const round = (n) => (n == null ? null : Math.round(n * 100) / 100);

/**
 * The Finance page as Claude may see it, from finance.getFinance()'s answer.
 * Built field by field from an allow-list, so a field added to finance.json
 * later stays private until someone decides otherwise here.
 */
function financeForAi(fin) {
  const share = shareSettings({ settings: fin.settings });
  const s = fin.summary || {};
  const open = (x) => x && !x.private;
  const out = { sharing: Object.keys(DEFAULT_SHARE).filter((k) => share[k] && !READ_SWITCHES.has(k)), hiddenByYou: [] };
  for (const k of Object.keys(DEFAULT_SHARE)) if (!share[k] && !READ_SWITCHES.has(k)) out.hiddenByYou.push(SHARE_LABELS[k]);

  const privateBills = new Set((fin.bills || []).filter((b) => b.private).map((b) => b.id));
  const cardIds = new Set((fin.accounts || []).filter((a) => a.type === 'credit').map((a) => a.id));

  if (share.bills) {
    out.upcomingBills = (s.upcoming || [])
      .filter((u) => !privateBills.has(u.billId) && (share.cards || !u.cardId))
      .map((u) => ({
        name: u.name, amount: u.amount, date: u.date, income: u.income, autopay: u.autopay, paid: u.paid, overdue: u.overdue, repeats: u.frequency,
      }));
    out.monthlyBills = s.monthlyBills;
    out.monthlyIncome = s.monthlyIncome;
  }
  if (share.budgets) {
    out.budgets = (s.budgets || []).filter(open).map((b) => ({ category: b.category, monthlyLimit: b.monthly, spent: b.spent, left: b.left, status: b.status }));
    out.month = { spent: s.month && s.month.spent, income: s.month && s.month.income, byCategory: s.month && s.month.categories };
  }
  if (share.goals) {
    out.goals = (s.goals || []).filter(open).map((g) => ({ name: g.name, target: g.target, saved: g.saved, by: g.by, perMonthNeeded: g.perMonth }));
  }
  if (share.subscriptions && s.subscriptions) {
    // Which account pays is left out unless accounts or cards are shared; never a card's digits.
    const cardsOk = share.cards, accountsOk = share.accounts;
    out.subscriptions = (s.subscriptions.list || []).filter(open).map((x) => ({
      name: x.name, plan: x.plan || null, amount: x.amount, repeats: x.frequency, status: x.status,
      nextCharge: x.nextCharge, trialEnds: x.status === 'trial' ? x.trialEnds : null, lastCharged: x.lastCharged, startedOn: x.startedOn,
      paidWith: (x.paidWith.type === 'card' && cardsOk) || (x.paidWith.type === 'bank' && accountsOk)
        ? String(x.paidWith.label).replace(/\s*••\d{4}$/, '') : x.paidWith.type,
      priceWentUp: x.priceUp ? { from: x.priceChange.from, to: x.priceChange.to } : null,
    }));
    out.subscriptionTotals = { perMonth: s.subscriptions.monthly, perYear: s.subscriptions.yearly, active: s.subscriptions.activeCount, trials: s.subscriptions.trialCount };
  }
  if (share.holdings) {
    out.holdings = (s.holdings || []).filter(open).map((h) => ({ symbol: h.symbol, shares: h.shares, value: h.value, dayChangePercent: round(h.dayChangePercent) }));
  }
  if (share.accounts) {
    out.accounts = (s.accounts || []).filter((a) => open(a) && !cardIds.has(a.id))
      .map((a) => ({ name: a.name, type: a.type, balance: a.balance == null ? null : a.value, updated: a.balance == null ? null : a.updatedAt }));
  }
  if (share.cards) {
    // Never the last four digits or the issuer's notes: a name, the numbers that matter, and dates.
    out.creditCards = (s.cards || []).filter(open).map((c) => ({
      name: c.name, balance: c.balance, limit: c.creditLimit, utilizationPercent: c.utilization == null ? null : Math.round(c.utilization),
      apr: c.apr, statementBalance: c.statementBalance, minimumPayment: c.minimumPayment, nextDue: c.nextDue, nextStatement: c.nextStatement, autopay: c.autopay,
    }));
  }
  if (share.transactions) {
    out.recentTransactions = (fin.transactions || []).filter(open).slice(0, 60)
      .map((t) => ({ date: t.date, description: redact(t.description), amount: t.amount, category: t.category }));
  }
  if (share.netWorth) {
    out.totals = { netWorth: s.netWorth, cash: s.cash, invested: s.invested, owed: s.debt };
  }
  return out;
}

module.exports = { DEFAULT_SHARE, SHARE_LABELS, READ_SWITCHES, shareSettings, redact, redactDeep, financeForAi, luhnOk };
