'use strict';
/**
 * health.js - what you eat, how you slept, the numbers you track, and the
 * gummies and supplements you take.
 *
 * Everything is typed in on the Health page, said to the assistant, or read
 * from an export you choose: Whoop's CSV (physiological_cycles.csv or
 * sleeps.csv) or Apple Health's export, which the browser boils down to one
 * line a day before it is sent here. Mellow does not sign in to Whoop or Apple.
 * Imported numbers carry their source, and importing the same export again
 * replaces what it brought rather than adding it twice.
 *
 * Kept in health.json next to finance.json, as plain readable JSON.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// RATCHET_DATA_DIR lets a test server use a scratch copy instead of yours.
const ROOT = process.env.RATCHET_DATA_DIR || path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'health.json');

const METRICS = {
  weight: { label: 'Weight', unit: 'lb' },
  water: { label: 'Water', unit: 'glasses' },
  steps: { label: 'Steps', unit: 'steps' },
  rhr: { label: 'Resting heart rate', unit: 'bpm' },
  hrv: { label: 'HRV', unit: 'ms' },
  recovery: { label: 'Recovery', unit: '%' },
  strain: { label: 'Strain', unit: '' },
  activeCal: { label: 'Active calories', unit: 'cal' },
  burned: { label: 'Calories burned', unit: 'cal' },
  spo2: { label: 'Blood oxygen', unit: '%' },
  mood: { label: 'Mood', unit: '/5' },
  energy: { label: 'Energy', unit: '/5' },
};
const MEALS = ['breakfast', 'lunch', 'dinner', 'snack', ''];
const WHEN = ['morning', 'midday', 'evening', 'night', 'any'];
const SOURCES = ['manual', 'assistant', 'whoop', 'apple'];

const DEFAULT_SETTINGS = {
  calorieGoal: 2200,
  proteinGoal: 0,
  sleepGoalHours: 8,
  waterGoal: 8,
  weightUnit: 'lb',
  shareWithAi: true,
};

/* --------------------------------- storage ------------------------------- */

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return fallback; }
}

function load() {
  const raw = readJson(DATA_FILE, {});
  return {
    _comment: raw._comment || 'Your health log, from the Health page. Safe to edit by hand while the engine runs.',
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    food: Array.isArray(raw.food) ? raw.food : [],
    sleep: Array.isArray(raw.sleep) ? raw.sleep : [],
    metrics: Array.isArray(raw.metrics) ? raw.metrics : [],
    supplements: Array.isArray(raw.supplements) ? raw.supplements : [],
    taken: raw.taken && typeof raw.taken === 'object' ? raw.taken : {},
    imports: Array.isArray(raw.imports) ? raw.imports : [],
  };
}

function save(data) {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

/** Load, change, save. Node runs this start to finish, so two requests cannot interleave. */
function change(fn) {
  const data = load();
  const result = fn(data);
  save(data);
  return result;
}

/* -------------------------------- validation ----------------------------- */

const pad = (n) => String(n).padStart(2, '0');
function dayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function dateOfKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

function cleanStr(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}
function cleanDay(v, fallback) {
  const s = String(v || '');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) { if (fallback) return fallback; throw new Error('The date should look like 2026-09-15.'); }
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  if (d.getMonth() !== +m[2] - 1) throw new Error('That date does not exist.');
  return s;
}
function cleanTime(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return '';
  return `${pad(+m[1])}:${m[2]}`;
}
function cleanNum(v, { min = 0, max = 1e6, places = 1, what = 'That' } = {}) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[,\s]/g, ''));
  if (!Number.isFinite(n)) throw new Error(`${what} should be a number.`);
  if (n < min || n > max) throw new Error(`${what} should be between ${min} and ${max}.`);
  return round(n, places);
}

/** Minutes between two clock times, across midnight when wake is earlier than bed. */
function hoursBetween(bed, wake) {
  if (!bed || !wake) return null;
  const [bh, bm] = bed.split(':').map(Number);
  const [wh, wm] = wake.split(':').map(Number);
  let mins = (wh * 60 + wm) - (bh * 60 + bm);
  if (mins <= 0) mins += 24 * 60;
  return round(mins / 60, 2);
}

/** A clean copy of one item, or an error a person can read. */
function validate(kind, input, today) {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(String(today || '')) ? today : dayKey(new Date());
  const i = input || {};
  const source = SOURCES.includes(i.source) ? i.source : 'manual';
  switch (kind) {
    case 'food': {
      const name = cleanStr(i.name, 80);
      if (!name) throw new Error('What did you eat?');
      const calories = cleanNum(i.calories, { max: 20000, places: 0, what: 'Calories' });
      if (calories == null) throw new Error('How many calories, roughly?');
      return {
        date: cleanDay(i.date, t), time: cleanTime(i.time), name, calories,
        protein: cleanNum(i.protein, { max: 1000, places: 0, what: 'Protein' }),
        meal: MEALS.includes(i.meal) ? i.meal : '', source,
      };
    }
    case 'sleep': {
      const bed = cleanTime(i.bed);
      const wake = cleanTime(i.wake);
      let hours = cleanNum(i.hours, { max: 24, places: 2, what: 'Hours' });
      if (hours == null) hours = hoursBetween(bed, wake);
      if (hours == null) throw new Error('Add when you went to bed and woke up, or how many hours you slept.');
      const quality = cleanNum(i.quality, { min: 1, max: 5, places: 0, what: 'Quality' });
      return {
        date: cleanDay(i.date, t), bed, wake, hours, quality,
        score: cleanNum(i.score, { max: 100, places: 0, what: 'Sleep score' }), note: cleanStr(i.note, 140), source,
      };
    }
    case 'metrics': {
      if (!METRICS[i.type]) throw new Error(`Pick what you are logging: ${Object.keys(METRICS).join(', ')}.`);
      const limits = { mood: [1, 5], energy: [1, 5], recovery: [0, 100], spo2: [0, 100], rhr: [20, 250], hrv: [1, 400], weight: [1, 1500] };
      const [min, max] = limits[i.type] || [0, 1e6];
      const value = cleanNum(i.value, { min, max, places: i.type === 'weight' || i.type === 'strain' ? 1 : 0, what: METRICS[i.type].label });
      if (value == null) throw new Error('Add a number.');
      return { date: cleanDay(i.date, t), type: i.type, value, note: cleanStr(i.note, 140), source };
    }
    case 'supplements': {
      const name = cleanStr(i.name, 60);
      if (!name) throw new Error('Name it, like "Magnesium gummies".');
      return { name, dose: cleanStr(i.dose, 40), when: WHEN.includes(i.when) ? i.when : 'any', active: i.active !== false && i.active !== 'false' };
    }
    default:
      throw new Error('Nothing to save.');
  }
}

const KINDS = ['food', 'sleep', 'metrics', 'supplements'];

function upsert(data, kind, input, today) {
  if (!KINDS.includes(kind)) throw new Error('Nothing to save.');
  const clean = validate(kind, input, today);
  const list = data[kind];
  const id = input && input.id ? String(input.id) : '';
  const existing = id ? list.find((x) => x.id === id) : null;
  if (id && !existing) throw new Error('That entry is no longer there.');
  if (existing) { Object.assign(existing, clean, { updatedAt: new Date().toISOString() }); return existing; }
  // One sleep a night: logging it again changes it rather than adding a second.
  if (kind === 'sleep') {
    const same = list.find((x) => x.date === clean.date && x.source === clean.source);
    if (same) { Object.assign(same, clean, { updatedAt: new Date().toISOString() }); return same; }
  }
  const item = { id: crypto.randomBytes(5).toString('hex'), ...clean, createdAt: new Date().toISOString() };
  list.push(item);
  return item;
}

function remove(data, kind, id) {
  if (!KINDS.includes(kind)) throw new Error('Nothing to delete.');
  const before = data[kind].length;
  data[kind] = data[kind].filter((x) => x.id !== id);
  if (data[kind].length === before) throw new Error('That entry is no longer there.');
  if (kind === 'supplements') for (const k of Object.keys(data.taken)) data.taken[k] = data.taken[k].filter((x) => x !== id);
}

function setTaken(data, date, id, on) {
  const day = cleanDay(date, dayKey(new Date()));
  if (!data.supplements.some((s) => s.id === id)) throw new Error('That supplement is no longer there.');
  const set = new Set(data.taken[day] || []);
  if (on) set.add(id); else set.delete(id);
  data.taken[day] = [...set];
  if (!data.taken[day].length) delete data.taken[day];
  // A year of ticks is plenty.
  const cutoff = dayKey(addDays(new Date(), -400));
  for (const k of Object.keys(data.taken)) if (k < cutoff) delete data.taken[k];
}

function setSettings(data, input) {
  const i = input || {};
  const s = data.settings;
  if (i.calorieGoal !== undefined) s.calorieGoal = cleanNum(i.calorieGoal, { max: 10000, places: 0, what: 'Calorie goal' }) || 0;
  if (i.proteinGoal !== undefined) s.proteinGoal = cleanNum(i.proteinGoal, { max: 1000, places: 0, what: 'Protein goal' }) || 0;
  if (i.sleepGoalHours !== undefined) s.sleepGoalHours = cleanNum(i.sleepGoalHours, { max: 16, places: 1, what: 'Sleep goal' }) || 0;
  if (i.waterGoal !== undefined) s.waterGoal = cleanNum(i.waterGoal, { max: 40, places: 0, what: 'Water goal' }) || 0;
  if (i.weightUnit !== undefined) s.weightUnit = i.weightUnit === 'kg' ? 'kg' : 'lb';
  if (i.shareWithAi !== undefined) s.shareWithAi = i.shareWithAi === true;
  return s;
}

/* --------------------------------- imports ------------------------------- */

/** RFC 4180-ish: quoted fields, doubled quotes, commas and newlines inside quotes. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text || '').replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

/** "2026-09-14 23:41:07" or "9/14/2026 11:41 PM" to { day, time }. */
function splitStamp(v) {
  const s = String(v || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/.exec(s);
  if (m) return { day: `${m[1]}-${m[2]}-${m[3]}`, time: `${pad(+m[4])}:${m[5]}` };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?)?/i.exec(s);
  if (m) {
    let h = +(m[4] || 0);
    if (m[6] && /pm/i.test(m[6]) && h < 12) h += 12;
    if (m[6] && /am/i.test(m[6]) && h === 12) h = 0;
    return { day: `${m[3]}-${pad(+m[1])}-${pad(+m[2])}`, time: m[4] ? `${pad(h)}:${m[5]}` : '' };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? { day: s, time: '' } : null;
}

/**
 * Whoop's data export: physiological_cycles.csv (recovery, strain, heart rate
 * and sleep together) or sleeps.csv. Returns one line a day, in the same shape
 * the browser sends for Apple Health.
 */
function parseWhoop(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('That file is empty.');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => {
    for (const n of names) { const i = head.findIndex((h) => h.startsWith(n)); if (i !== -1) return i; }
    return -1;
  };
  const c = {
    start: col('cycle start time'), end: col('cycle end time'), onset: col('sleep onset'), wake: col('wake onset'),
    recovery: col('recovery score'), rhr: col('resting heart rate'), hrv: col('heart rate variability'),
    strain: col('day strain'), burned: col('energy burned'), spo2: col('blood oxygen'),
    asleep: col('asleep duration'), perf: col('sleep performance'), nap: col('nap'),
  };
  if (c.recovery === -1 && c.asleep === -1 && c.strain === -1) {
    throw new Error('That doesn\'t look like a Whoop export. In the Whoop app: More → App Settings → Data Export, then use physiological_cycles.csv or sleeps.csv from the email.');
  }
  const days = new Map();
  const num = (row, i) => {
    if (i === -1) return null;
    const n = Number(String(row[i] || '').replace(/[%,\s]/g, ''));
    return String(row[i] || '').trim() !== '' && Number.isFinite(n) ? n : null;
  };
  for (const row of rows.slice(1)) {
    if (c.nap !== -1 && /^true$/i.test(String(row[c.nap]).trim())) continue;
    const wake = splitStamp(row[c.wake]);
    const onset = splitStamp(row[c.onset]);
    // The day a cycle belongs to is the morning you woke up.
    const when = wake || splitStamp(row[c.end]) || splitStamp(row[c.start]);
    if (!when) continue;
    const d = days.get(when.day) || { date: when.day };
    const set = (k, v) => { if (v != null) d[k] = v; };
    set('recovery', num(row, c.recovery));
    set('rhr', num(row, c.rhr));
    set('hrv', num(row, c.hrv));
    set('strain', num(row, c.strain));
    set('burned', num(row, c.burned));
    set('spo2', num(row, c.spo2));
    const asleep = num(row, c.asleep);
    if (asleep != null) {
      d.sleepHours = round(asleep / 60, 2);
      if (onset) d.bed = onset.time;
      if (wake) d.wake = wake.time;
      set('sleepScore', num(row, c.perf));
    }
    days.set(when.day, d);
  }
  const out = [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!out.length) throw new Error('No days with numbers in that file.');
  return out;
}

/**
 * Days from an import, merged in. Each value gets a fixed id from its source,
 * type and date, so importing the same export twice changes nothing.
 */
function importDays(data, source, days) {
  if (!['whoop', 'apple'].includes(source)) throw new Error('Unknown import.');
  if (!Array.isArray(days) || !days.length) throw new Error('Nothing to import.');
  const unit = data.settings.weightUnit;
  const counts = { days: 0, sleep: 0, metrics: 0, food: 0 };
  const cutoff = dayKey(addDays(new Date(), -800));
  const put = (list, id, item) => {
    const i = list.findIndex((x) => x.id === id);
    const full = { id, ...item, source, importedAt: new Date().toISOString() };
    if (i === -1) list.push(full); else list[i] = full;
  };
  for (const raw of days.slice(-800)) {
    let date;
    try { date = cleanDay(raw && raw.date); } catch (_) { continue; }
    if (date < cutoff) continue;
    counts.days++;
    const n = (v, lo, hi, places = 0) => {
      const x = Number(v);
      return v != null && v !== '' && Number.isFinite(x) && x >= lo && x <= hi ? round(x, places) : null;
    };
    const hours = n(raw.sleepHours, 0.1, 24, 2);
    if (hours != null) {
      put(data.sleep, `${source}:sleep:${date}`, { date, bed: cleanTime(raw.bed), wake: cleanTime(raw.wake), hours, quality: null, score: n(raw.sleepScore, 0, 100), note: '' });
      counts.sleep++;
    }
    const metric = (type, value) => {
      if (value == null) return;
      put(data.metrics, `${source}:${type}:${date}`, { date, type, value, note: '' });
      counts.metrics++;
    };
    metric('recovery', n(raw.recovery, 0, 100));
    metric('rhr', n(raw.rhr, 20, 250));
    metric('hrv', n(raw.hrv, 1, 400));
    metric('strain', n(raw.strain, 0, 30, 1));
    metric('burned', n(raw.burned, 0, 20000));
    metric('activeCal', n(raw.activeCal, 0, 20000));
    metric('steps', n(raw.steps, 0, 200000));
    // Apple writes blood oxygen as a fraction, Whoop as a percent.
    const o2 = Number(raw.spo2);
    metric('spo2', n(Number.isFinite(o2) && o2 > 0 && o2 <= 1 ? o2 * 100 : raw.spo2, 0, 100, 1));
    if (raw.weight && typeof raw.weight === 'object') {
      const v = Number(raw.weight.value);
      const from = String(raw.weight.unit || '').toLowerCase();
      if (Number.isFinite(v) && v > 0) {
        const kg = from === 'kg' ? v : from === 'g' ? v / 1000 : v * 0.45359237;
        metric('weight', round(unit === 'kg' ? kg : kg / 0.45359237, 1));
      }
    }
    const eaten = n(raw.caloriesIn, 1, 20000);
    if (eaten != null) {
      put(data.food, `${source}:food:${date}`, { date, time: '', name: `Logged in ${source === 'apple' ? 'Apple Health' : 'Whoop'}`, calories: eaten, protein: n(raw.proteinIn, 0, 1000), meal: '' });
      counts.food++;
    }
  }
  data.imports = [{ source, at: new Date().toISOString(), ...counts }, ...data.imports.filter((x) => x.source !== source)].slice(0, 10);
  return counts;
}

/* --------------------------------- summary ------------------------------- */

function summary(data, now = new Date()) {
  const today = dayKey(now);
  const s = data.settings;
  const byDay = (list, day) => list.filter((x) => x.date === day);

  const foodToday = byDay(data.food, today).sort((a, b) => ((a.time || '99') < (b.time || '99') ? -1 : 1));
  const eaten = foodToday.reduce((t, f) => t + (f.calories || 0), 0);
  const protein = foodToday.reduce((t, f) => t + (f.protein || 0), 0);

  // A manual entry wins over an import for the same night.
  const sleepFor = (day) => {
    const all = byDay(data.sleep, day);
    return all.find((x) => x.source === 'manual' || x.source === 'assistant') || all[0] || null;
  };
  const metricFor = (day, type) => {
    const all = data.metrics.filter((m) => m.date === day && m.type === type);
    if (!all.length) return null;
    // Water and steps typed in by hand add up; anything else, the latest counts.
    if (type === 'water') return all.reduce((t, m) => t + m.value, 0);
    const own = all.filter((m) => m.source === 'manual' || m.source === 'assistant');
    const pick = own.length ? own : all;
    return pick[pick.length - 1].value;
  };

  const days = [];
  for (let i = 13; i >= 0; i--) {
    const k = dayKey(addDays(dateOfKey(today), -i));
    const sl = sleepFor(k);
    const food = byDay(data.food, k);
    days.push({
      date: k,
      calories: food.length ? food.reduce((t, f) => t + (f.calories || 0), 0) : null,
      sleepHours: sl ? sl.hours : null,
      steps: metricFor(k, 'steps'),
      recovery: metricFor(k, 'recovery'),
      weight: metricFor(k, 'weight'),
      water: metricFor(k, 'water'),
      supplements: (data.taken[k] || []).length,
    });
  }

  const latest = {};
  for (const type of Object.keys(METRICS)) {
    const all = data.metrics.filter((m) => m.type === type).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (!all.length) continue;
    const last = all[all.length - 1];
    const prev = all.filter((m) => m.date < last.date).pop();
    latest[type] = { value: metricFor(last.date, type), date: last.date, source: last.source, previous: prev ? metricFor(prev.date, type) : null };
  }

  const recentSleep = days.map((d) => d.sleepHours).filter((h) => h != null).slice(-7);
  const lastNight = sleepFor(today) || sleepFor(dayKey(addDays(dateOfKey(today), -1)));
  const active = data.supplements.filter((x) => x.active !== false);
  const takenToday = new Set(data.taken[today] || []);

  // Days in a row, up to yesterday or today, with every active supplement taken.
  let streak = 0;
  if (active.length) {
    for (let i = 0; i < 400; i++) {
      const k = dayKey(addDays(dateOfKey(today), -i));
      const got = new Set(data.taken[k] || []);
      const all = active.every((x) => got.has(x.id));
      if (all) streak++;
      else if (i > 0) break;
    }
  }

  return {
    today,
    settings: s,
    calories: { eaten, protein, goal: s.calorieGoal, left: s.calorieGoal ? s.calorieGoal - eaten : null, proteinGoal: s.proteinGoal },
    food: foodToday,
    sleep: { lastNight, average7: recentSleep.length ? round(recentSleep.reduce((a, b) => a + b, 0) / recentSleep.length, 2) : null, goal: s.sleepGoalHours },
    water: {
      today: metricFor(today, 'water') || 0, goal: s.waterGoal,
      // So a glass added by mistake can be taken off again, newest first.
      entries: data.metrics.filter((m) => m.date === today && m.type === 'water' && m.source !== 'whoop' && m.source !== 'apple').map((m) => m.id).reverse(),
    },
    supplements: data.supplements.map((x) => ({ ...x, takenToday: takenToday.has(x.id) })),
    supplementStreak: streak,
    latest,
    days,
    imports: data.imports,
  };
}

function getHealth() {
  const data = load();
  // One line a night: what you logged yourself wins over an import.
  const nights = new Map();
  for (const n of data.sleep) {
    const had = nights.get(n.date);
    const own = (x) => x.source === 'manual' || x.source === 'assistant';
    if (!had || (own(n) && !own(had))) nights.set(n.date, n);
  }
  const sleepLog = [...nights.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 14);
  return { metrics: METRICS, summary: summary(data), sleepLog };
}

/** What the assistant is shown, when the student allows it. */
function forAi(data) {
  if (!data.settings.shareWithAi) throw new Error('The student has not shared health data with the assistant. It can be turned on from the Health page.');
  const s = summary(data);
  const strip = (x) => { const { id, createdAt, updatedAt, importedAt, ...rest } = x; return rest; };
  return {
    today: s.today,
    goals: { calories: s.settings.calorieGoal, protein: s.settings.proteinGoal, sleepHours: s.settings.sleepGoalHours, water: s.settings.waterGoal, weightUnit: s.settings.weightUnit },
    eatenToday: { calories: s.calories.eaten, protein: s.calories.protein, food: s.food.map(strip) },
    sleep: { lastNight: s.sleep.lastNight ? strip(s.sleep.lastNight) : null, average7Hours: s.sleep.average7 },
    waterToday: s.water.today,
    supplements: s.supplements.map((x) => ({ name: x.name, dose: x.dose, when: x.when, active: x.active, takenToday: x.takenToday })),
    supplementStreakDays: s.supplementStreak,
    latestMetrics: Object.fromEntries(Object.entries(s.latest).map(([k, v]) => [METRICS[k].label, { value: v.value, unit: k === 'weight' ? s.settings.weightUnit : METRICS[k].unit, date: v.date, source: v.source }])),
    last14Days: s.days,
  };
}

module.exports = {
  DATA_FILE, METRICS, MEALS, WHEN, KINDS,
  load, save, change, validate, upsert, remove, setTaken, setSettings,
  parseCsv, parseWhoop, importDays, summary, getHealth, forAi, hoursBetween, dayKey,
};
