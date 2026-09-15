'use strict';
/**
 * groups.js - the clubs, teams and committees you belong to, found in your
 * calendar and email, and confirmed by you.
 *
 * A group is noticed when its name keeps turning up: "SAAC Meeting" on the
 * calendar, "[SAAC] Dodgeball sign-ups" in the inbox, an email welcoming you to
 * the Student-Athlete Advisory Committee. Once it has turned up enough, Today
 * asks whether you are in it. Say yes and its meetings and events are labelled
 * with it; say no and it is never suggested again.
 *
 * Only short names and titles are kept as evidence, never email bodies. Kept
 * in groups.json, with the label choices you made on the calendar.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const labels = require('./labels');

// RATCHET_DATA_DIR lets a test server use a scratch copy instead of yours.
const ROOT = process.env.RATCHET_DATA_DIR || path.join(__dirname, '..');
const FILE = path.join(ROOT, 'groups.json');

const SUGGEST_AT = 2;
const STATUSES = ['watching', 'suggested', 'joined', 'dismissed'];

/* -------------------------------- storage -------------------------------- */

function load() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, '')); } catch (_) {}
  return {
    groups: Array.isArray(raw.groups) ? raw.groups.filter((g) => g && g.id && g.name) : [],
    overrides: raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {},
  };
}

function save(state) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    _comment: 'Groups you are in (status "joined"), ones Mellow noticed, and the calendar labels you changed. Safe to edit while the engine runs.',
    groups: state.groups,
    overrides: state.overrides,
  }, null, 2));
  fs.renameSync(tmp, FILE);
}

/* ------------------------------- noticing -------------------------------- */

// Capitals that are not the name of a group.
const STOP = new Set(`THE AND FOR YOU YOUR ALL NEW FREE NOW DUE TBD TBA FAQ RSVP ASAP FYI PDF EST EDT PST PDT CST CDT UTC GMT USA NYC
CEO GPA EXAM EXAMS QUIZ MIDTERM FINAL FINALS LAB NOTE URGENT REMINDER UPDATE IMPORTANT ACTION REQUIRED TODAY THIS WEEK NEXT
NCAA NESCAC ZOOM WWI WWII LLC INC IRS FAFSA SAT GRE GMAT MCAT LSAT PIN OTP SMS URL HTML API USD BTC ETH SOL ETF IPO APR APY ATM
ACH WIN PAPER FIRST ASSIGNED CLASS SALE DEAL OFF GOV ECO ENG BIO CHEM MATH HIST PHIL PSY ECON INTL STEM DEI HR IT TA RE FWD
EXTERNAL SPAM CANCELLED CANCELED POSTPONED RESCHEDULED NOTICE ALERT OPEN CLOSED LAST CHANCE LIVE DAY NIGHT AM PM MON TUE WED
THU FRI SAT SUN JAN FEB MAR APR MAY JUN JUL AUG SEP SEPT OCT NOV DEC VS HQ`.split(/\s+/));

const ORG_WORD = 'Club|Team|Committee|Council|Society|Association|Board|Union|Alliance|Collective|Ensemble|Chorus|Choir|Band|Orchestra|Fraternity|Sorority|Chapter|Coalition|League|Organization|Senate|Squad|Crew|Staff';
const PHRASE = new RegExp(`\\b([A-Z][\\w'&.-]*(?:[\\s-]+(?:[A-Z][\\w'&.-]*|and|of|&|for|the)){0,6}[\\s-]+(?:${ORG_WORD}))\\b`, 'g');
const TEAM = /\b(team|squad|athletic|varsity|club sport|swim|dive|soccer|lacrosse|hockey|rowing|crew|track|field|tennis|basketball|baseball|softball|volleyball|squash|sailing|golf|rugby|cross country|fencing)\b/i;
const MEETING_WORD = /\b(meeting|gbm|general body|board|committee|council)\b/i;
const WELCOME = /\b(welcome to|you('ve| have) (been )?(added|accepted|selected)|you('re| are) (now )?(a member|in)|new members?|member(ship)? (confirmation|approved)|joined)\b/i;

/** "SAAC", but not "ECO 112", not "DUE", and not a word in an all-capitals headline. */
function acronymsIn(text) {
  const words = String(text || '').split(/\s+/);
  const out = new Set();
  words.forEach((w, i) => {
    const m = /^[^A-Za-z0-9]*([A-Z][A-Z&]{2,6})[^A-Za-z0-9]*$/.exec(w);
    if (!m) return;
    const tok = m[1].replace(/&$/, '');
    if (tok.length < 3 || STOP.has(tok)) return;
    const shouted = (n) => n && /[A-Z]{2,}/.test(n) && !/[a-z]/.test(n) && !/^\W*\d/.test(n) && !/^[^A-Za-z]*[A-Z][^A-Za-z]*$/.test(n);
    if (shouted(words[i - 1]) || shouted(words[i + 1])) return;
    if (words[i + 1] && /^\d{2,3}[A-Z]?\b/.test(words[i + 1])) return;
    out.add(tok);
  });
  return [...out];
}

/** "Student-Athlete Advisory Committee", from "Welcome to the Student-Athlete Advisory Committee!" */
function phrasesIn(text) {
  const out = new Set();
  const s = String(text || '');
  PHRASE.lastIndex = 0;
  let m;
  while ((m = PHRASE.exec(s))) {
    const name = m[1].replace(/^(the|welcome|join|dear|hi|hello)\s+/i, '').replace(/^[A-Z]\w+\s+(College|University)\s+/, '').trim();
    if (name.split(/\s+/).length >= 2 && name.length <= 60) out.add(name);
  }
  return [...out];
}

function initials(phrase) {
  return phrase.split(/[\s-]+/).filter((w) => !/^(and|of|&|for|the)$/i.test(w)).map((w) => w[0].toUpperCase()).join('');
}

function idFor(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || crypto.randomBytes(4).toString('hex');
}

/**
 * What a calendar entry says about the groups you might be in. One signal per
 * name per distinct title, so a weekly meeting counts once.
 */
function signalsFromEvents(events) {
  const out = [];
  const seen = new Set();
  for (const e of events || []) {
    if (/holiday/i.test(e.calendar || '') || e.isDeadline || e.type === 'deadline') continue;
    const title = String(e.title || '');
    const key = labels.titleKey(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const weight = MEETING_WORD.test(title) ? 2 : 1;
    for (const token of acronymsIn(title)) out.push({ token, ref: `cal:${key}`, weight, source: 'calendar', title });
    for (const phrase of phrasesIn(title)) out.push({ phrase, ref: `cal:${key}`, weight, source: 'calendar', title });
  }
  return out;
}

/**
 * What an email says: the names in its subject, in who sent it, and in its
 * mailing list's name. An email welcoming you in counts for more.
 * msg: { id, subject, from, listId, snippet, labels, date }
 */
function signalsFromEmail(msg) {
  if (!msg) return [];
  const l = msg.labels || [];
  if (l.includes('SENT') || l.includes('CATEGORY_PROMOTIONS') || l.includes('CATEGORY_SOCIAL')) return [];
  const subject = String(msg.subject || '').replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '');
  const sender = String(msg.from || '').replace(/<[^>]*>/, '').replace(/"/g, '').trim();
  const list = String(msg.listId || '').replace(/<[^>]*>/, '').replace(/"/g, '').trim();
  const tag = (/^\s*\[([^\]]{2,40})\]/.exec(subject) || [])[1] || '';
  const text = [subject, sender, list, tag].join(' \n ');
  const weight = WELCOME.test(`${subject} ${msg.snippet || ''}`) ? 3 : 1;
  const base = { ref: `mail:${msg.id}`, weight, source: 'email', title: subject.slice(0, 120), at: msg.date instanceof Date ? msg.date.toISOString() : msg.date || null };
  const out = [];
  const tokens = new Set(acronymsIn(text));
  for (const token of tokens) out.push({ ...base, token });
  for (const phrase of new Set([...phrasesIn(text), ...phrasesIn(msg.snippet || '')])) out.push({ ...base, phrase });
  return out;
}

/**
 * Fold signals into the saved groups. Returns the groups that have just
 * become worth asking about. Joined and dismissed groups keep their status;
 * their evidence still grows, so "SAAC" can gain its full name later.
 */
function observe(state, signals, now = new Date()) {
  const became = [];
  let changed = false;
  const findBy = (name) => state.groups.find((g) => g.id === idFor(name) || g.name.toLowerCase() === name.toLowerCase() ||
    (g.aliases || []).some((a) => a.toLowerCase() === name.toLowerCase()));

  for (const s of signals || []) {
    let g = s.token ? findBy(s.token) : null;
    if (!g && s.phrase) {
      g = findBy(s.phrase);
      // The full name of a group already known by its initials.
      if (!g) g = state.groups.find((x) => /^[A-Z&]{3,7}$/.test(x.name) && x.name.replace(/&/g, '') === initials(s.phrase)) || null;
      if (g && g.name !== s.phrase && !(g.aliases || []).includes(s.phrase)) { g.aliases = [...(g.aliases || []), s.phrase].slice(0, 4); changed = true; }
    }
    if (!g) {
      const name = s.token || s.phrase;
      // A long name whose initials are a known short name joins it rather than starting a second group.
      g = {
        id: idFor(name), name, aliases: [], kind: TEAM.test(name) ? 'team' : 'club', status: 'watching', attend: 'required',
        score: 0, refs: {}, evidence: [], firstSeen: now.toISOString(),
      };
      state.groups.push(g);
      changed = true;
    }
    g.refs = g.refs || {};
    if (g.refs[s.ref] != null && g.refs[s.ref] >= s.weight) continue;
    g.refs[s.ref] = s.weight;
    const keys = Object.keys(g.refs);
    if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete g.refs[k];
    g.score = Object.values(g.refs).reduce((a, b) => a + b, 0);
    g.evidence = [{ source: s.source, title: s.title || '', at: s.at || now.toISOString() }, ...(g.evidence || []).filter((e) => e.title !== s.title)].slice(0, 6);
    g.lastSeen = now.toISOString();
    if (TEAM.test(s.title || '') && g.kind !== 'team' && /\b(practice|lift|scrimmage|game|meet)\b/i.test(s.title || '')) g.kind = 'team';
    if (g.status === 'watching' && g.score >= SUGGEST_AT) { g.status = 'suggested'; g.suggestedAt = now.toISOString(); became.push(g); }
    changed = true;
  }
  if (state.groups.length > 200) {
    // Names seen once long ago are forgotten first; anything you decided on is kept.
    state.groups = state.groups.filter((g) => g.status !== 'watching' || g.score > 1).slice(-200);
  }
  return { changed, became };
}

/* -------------------------------- deciding ------------------------------- */

function publicGroup(g) {
  const refs = Object.keys(g.refs || {});
  return {
    id: g.id, name: g.name, aliases: g.aliases || [], kind: g.kind, status: g.status, attend: g.attend || 'required',
    calendarCount: refs.filter((r) => r.startsWith('cal:')).length,
    emailCount: refs.filter((r) => r.startsWith('mail:')).length,
    evidence: (g.evidence || []).slice(0, 3), firstSeen: g.firstSeen, decidedAt: g.decidedAt || null,
  };
}

function summary(state = load()) {
  return {
    suggested: state.groups.filter((g) => g.status === 'suggested').sort((a, b) => b.score - a.score).slice(0, 5).map(publicGroup),
    joined: state.groups.filter((g) => g.status === 'joined').map(publicGroup),
  };
}

/** Yes, I'm in it; or no, I'm not. Also used to leave a group later. */
function decide(state, id, join, patch = {}) {
  const g = state.groups.find((x) => x.id === id);
  if (!g) throw new Error('That group is no longer there.');
  g.status = join ? 'joined' : 'dismissed';
  g.decidedAt = new Date().toISOString();
  if (join) {
    if (typeof patch.name === 'string' && patch.name.trim()) g.name = patch.name.trim().slice(0, 60);
    if (['club', 'team'].includes(patch.kind)) g.kind = patch.kind;
    if (labels.ATTEND.includes(patch.attend)) g.attend = patch.attend;
  }
  return g;
}

/** A group you name yourself. */
function addGroup(state, name, kind) {
  const clean = String(name || '').replace(/[\u0000-\u001f<>"\\]/g, '').trim().slice(0, 60);
  if (!clean) throw new Error('Give the group a name.');
  let g = state.groups.find((x) => x.id === idFor(clean) || x.name.toLowerCase() === clean.toLowerCase());
  if (!g) {
    g = { id: idFor(clean), name: clean, aliases: [], kind: kind === 'team' ? 'team' : 'club', status: 'joined', attend: 'required', score: 0, refs: {}, evidence: [], firstSeen: new Date().toISOString() };
    state.groups.push(g);
  }
  g.status = 'joined';
  g.decidedAt = new Date().toISOString();
  return g;
}

/**
 * Overrule a calendar label for every entry with this title.
 * patch: { attend: 'required' | 'optional' | null, type }. { reset: true } goes back to the guess.
 */
function setLabel(state, title, patch) {
  const key = labels.titleKey(title);
  if (!key) throw new Error('That entry has no title to remember it by.');
  if (patch && patch.reset) { delete state.overrides[key]; return null; }
  const o = { ...(state.overrides[key] || {}) };
  if (patch && 'attend' in patch) o.attend = labels.ATTEND.includes(patch.attend) ? patch.attend : null;
  if (patch && patch.type && labels.TYPES[patch.type]) o.type = patch.type;
  state.overrides[key] = o;
  const keys = Object.keys(state.overrides);
  if (keys.length > 500) delete state.overrides[keys[0]];
  return o;
}

function joined(state = load()) {
  return state.groups.filter((g) => g.status === 'joined');
}

/** The Gmail search for group mail. */
function query(days) {
  return `newer_than:${days}d -category:promotions -category:social -in:sent -in:chats ` +
    '{meeting meetings "general body" gbm club committee council team captains members membership "welcome to" "added to" practice tryouts board}';
}

module.exports = {
  FILE, SUGGEST_AT, STATUSES,
  load, save, observe, summary, decide, addGroup, setLabel, joined, query,
  signalsFromEvents, signalsFromEmail, acronymsIn, phrasesIn, initials, idFor,
};
