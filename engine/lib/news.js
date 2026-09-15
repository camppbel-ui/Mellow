'use strict';
/**
 * news.js - today's most important stories, in someone else's ranking.
 *
 * Mellow does not decide what matters in the world. Google News does that
 * for its Top Stories feed, ordering stories by how widely and prominently
 * they are being covered, and each story arrives with the other outlets
 * covering it. That coverage count is shown as-is, so the ranking can be
 * sanity-checked at a glance.
 *
 * Feeds are cached on disk like the calendars. The dashboard asks every thirty
 * seconds and the sleep screen sits open all night; neither should turn into
 * a request to Google each time, and a dropped connection should show the
 * last ranking rather than a blank widget.
 *
 * Only sources listed in news.json can be fetched. The dashboard picks one by
 * id, never by URL, so the endpoint cannot be used to make the PC fetch
 * arbitrary addresses.
 */

const fs = require('fs');
const path = require('path');

const { fetchText } = require('./calendar');

const ROOT = path.join(__dirname, '..');
const SETTINGS_FILE = path.join(ROOT, 'news.json');
const CACHE_DIR = path.join(ROOT, 'news-cache');

const DEFAULT_SOURCES = [
  {
    id: 'google-top',
    label: 'Top stories',
    name: 'Google News · Top stories',
    ranking: 'Ranked by Google News by how widely each story is being covered.',
    url: 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en',
    home: 'https://news.google.com/',
  },
  {
    id: 'google-world',
    label: 'World',
    name: 'Google News · World',
    ranking: 'Ranked by Google News, world stories only.',
    url: 'https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en',
    home: 'https://news.google.com/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pWVXlnQVAB',
  },
  {
    id: 'bbc',
    label: 'BBC',
    name: 'BBC News · Top stories',
    ranking: 'In the order BBC News editors placed them on the front page.',
    url: 'https://feeds.bbci.co.uk/news/rss.xml',
    home: 'https://www.bbc.co.uk/news',
  },
];

function loadSettings() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^﻿/, ''));
  } catch (_) {}
  const sources = (Array.isArray(raw.sources) && raw.sources.length ? raw.sources : DEFAULT_SOURCES)
    .filter((s) => s && s.id && s.url && !String(s.id).startsWith('_') && !s.disabled);
  return {
    defaultSource: raw.defaultSource || (sources[0] && sources[0].id) || 'google-top',
    refreshMinutes: Math.max(5, Number(raw.refreshMinutes) || 30),
    maxStories: Math.min(50, Math.max(1, Number(raw.maxStories) || 20)),
    sources,
  };
}

/* ------------------------------- parsing --------------------------------- */

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch (_) { return m; }
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** The text of one child element, CDATA or entity-encoded, or ''. */
function tag(xml, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  if (!m) return '';
  const inner = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
  return cdata ? cdata[1] : decodeEntities(inner);
}

function stripHtml(html) {
  // Tags become spaces so "<br>" does not glue words together, and the space
  // that leaves before punctuation ("<b>risks</b>.") is taken back out.
  return decodeEntities(String(html || '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').replace(/ ([.,;:!?])/g, '$1').trim();
}

/**
 * Google News puts the other outlets covering a story in the description, as
 * a list: the story itself first, then the rest. Each is
 * <li><a href="...">Headline</a>&nbsp;&nbsp;<font>Outlet</font></li>.
 */
function googleCoverage(descriptionHtml) {
  const out = [];
  const re = /<li>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(descriptionHtml))) {
    const a = /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(m[1]);
    const font = /<font[^>]*>([\s\S]*?)<\/font>/i.exec(m[1]);
    if (!a || !font) continue; // "View full coverage" has no outlet.
    out.push({ title: stripHtml(a[2]), outlet: stripHtml(font[1]), link: decodeEntities(a[1]) });
  }
  return out;
}

/**
 * The picture a publisher attaches to the item for readers like this one:
 * media:content or media:thumbnail (the Times, the Journal, the BBC) or an
 * image enclosure. The largest one offered wins. Only http(s) addresses.
 */
function imageOf(item) {
  let best = '';
  let bestWidth = -1;
  const re = /<(media:content|media:thumbnail|enclosure)\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(item))) {
    const attrs = m[2];
    const url = (/\burl="([^"]+)"/i.exec(attrs) || [])[1];
    if (!url) continue;
    const type = (/\btype="([^"]+)"/i.exec(attrs) || [])[1] || '';
    const medium = (/\bmedium="([^"]+)"/i.exec(attrs) || [])[1] || '';
    if (m[1].toLowerCase() !== 'media:thumbnail' && !/^image\//i.test(type) && medium !== 'image' && !/\.(jpe?g|png|webp)(\?|$)/i.test(url)) continue;
    const width = parseInt((/\bwidth="(\d+)"/i.exec(attrs) || [])[1], 10) || 0;
    const clean = decodeEntities(url);
    if (/^https?:\/\//i.test(clean) && width > bestWidth) { best = clean; bestWidth = width; }
  }
  return best;
}

/**
 * Items in feed order. The order IS the ranking, so rank is just position.
 */
function parseFeed(xml, max = 20) {
  const stories = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) && stories.length < max) {
    const item = m[1];
    let title = stripHtml(tag(item, 'title'));
    const link = tag(item, 'link').trim();
    if (!title || !/^https?:\/\//i.test(link)) continue;

    const outletTag = stripHtml(tag(item, 'source'));
    const description = tag(item, 'description');
    const coverage = /<li>/i.test(description) ? googleCoverage(description) : [];

    // "Headline - The Outlet" -> "Headline", when the feed names the outlet.
    let outlet = outletTag;
    if (outlet && title.endsWith(` - ${outlet}`)) title = title.slice(0, -(outlet.length + 3));
    if (!outlet && coverage.length) outlet = coverage[0].outlet;

    const pub = new Date(tag(item, 'pubDate'));
    stories.push({
      rank: stories.length + 1,
      title,
      outlet: outlet || '',
      link,
      publishedAt: Number.isNaN(pub.getTime()) ? null : pub.toISOString(),
      summary: coverage.length ? '' : stripHtml(description).slice(0, 280),
      image: imageOf(item),
      // How many outlets are on it, counting the one linked.
      outlets: coverage.length || 1,
      // Google lists at most five, so five means five or more.
      outletsMore: coverage.length >= 5,
      related: coverage.slice(1, 6),
    });
  }
  return stories;
}

/* -------------------------------- caching -------------------------------- */

function cacheFile(id) {
  return path.join(CACHE_DIR, `${String(id).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60)}.json`);
}

function readCache(id) {
  try { return JSON.parse(fs.readFileSync(cacheFile(id), 'utf8')); } catch (_) { return null; }
}

const inFlight = new Map();

function refresh(source, settings) {
  if (inFlight.has(source.id)) return inFlight.get(source.id);
  const p = (async () => {
    const res = await fetchText(source.url, 15000);
    const prev = readCache(source.id);
    if (!res.ok) {
      const kept = { ...(prev || { stories: [] }), lastError: res.error, lastTriedAt: new Date().toISOString() };
      writeCache(source.id, kept);
      return kept;
    }
    const stories = parseFeed(res.body, settings.maxStories);
    if (!stories.length) {
      const kept = { ...(prev || { stories: [] }), lastError: 'the feed had no stories in it', lastTriedAt: new Date().toISOString() };
      writeCache(source.id, kept);
      return kept;
    }
    const fresh = { fetchedAt: new Date().toISOString(), lastTriedAt: new Date().toISOString(), lastError: null, stories };
    writeCache(source.id, fresh);
    return fresh;
  })().finally(() => inFlight.delete(source.id));
  inFlight.set(source.id, p);
  return p;
}

function writeCache(id, obj) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const file = cacheFile(id);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(obj, null, 2));
    fs.renameSync(`${file}.tmp`, file);
  } catch (_) {
    // A read-only folder costs the cache, not the news.
  }
}

/* ------------------------- The Times and the Journal --------------------- */

/**
 * The papers you want to read a big story in. For each ranked story, Mellow
 * looks for the same story in their own feeds and links straight to it. The
 * links go to nytimes.com and wsj.com, so their paywalls and your
 * subscriptions apply as usual.
 */
const DEFAULT_PAPERS = [
  {
    id: 'nyt', name: 'The New York Times', short: 'NYT',
    outlets: ['the new york times', 'new york times', 'nytimes.com', 'nyt'],
    feeds: ['https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml'],
  },
  {
    id: 'wsj', name: 'The Wall Street Journal', short: 'WSJ',
    outlets: ['wsj', 'the wall street journal', 'wall street journal', 'wsj.com'],
    feeds: [
      'https://feeds.content.dowjones.io/public/rss/RSSWorldNews',
      'https://feeds.content.dowjones.io/public/rss/RSSUSnews',
      'https://feeds.content.dowjones.io/public/rss/socialpoliticsfeed',
      'https://feeds.content.dowjones.io/public/rss/WSJcomUSBusiness',
      'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain',
    ],
  },
];

/**
 * Papers you might pay for. Subscribing to one on the News page adds its
 * feeds to the matching, puts its "Read in" button first, and marks it as
 * yours. A site cannot see what you are signed into elsewhere, so Mellow is
 * told: by you, or by a suggestion from subscription emails in your inbox.
 * `mail` are the sender domains those emails come from.
 */
const CATALOG = [
  { ...DEFAULT_PAPERS[1], mail: ['wsj.com', 'dowjones.com', 'barrons.com'] },
  { ...DEFAULT_PAPERS[0], mail: ['nytimes.com'] },
  {
    id: 'wapo', name: 'The Washington Post', short: 'WaPo', outlets: ['the washington post', 'washington post', 'washingtonpost.com'],
    feeds: ['https://feeds.washingtonpost.com/rss/national', 'https://feeds.washingtonpost.com/rss/world'], mail: ['washingtonpost.com'],
  },
  {
    id: 'ft', name: 'Financial Times', short: 'FT', outlets: ['financial times', 'ft.com', 'ft'],
    feeds: ['https://www.ft.com/rss/home'], mail: ['ft.com'],
  },
  {
    id: 'bloomberg', name: 'Bloomberg', short: 'Bloomberg', outlets: ['bloomberg', 'bloomberg.com'],
    feeds: ['https://feeds.bloomberg.com/markets/news.rss', 'https://feeds.bloomberg.com/politics/news.rss'], mail: ['bloomberg.com', 'bloomberg.net'],
  },
  {
    id: 'economist', name: 'The Economist', short: 'Economist', outlets: ['the economist', 'economist', 'economist.com'],
    feeds: ['https://www.economist.com/latest/rss.xml'], mail: ['economist.com'],
  },
  {
    id: 'newyorker', name: 'The New Yorker', short: 'New Yorker', outlets: ['the new yorker', 'new yorker', 'newyorker.com'],
    feeds: ['https://www.newyorker.com/feed/news'], mail: ['newyorker.com', 'condenast.com'],
  },
  {
    id: 'latimes', name: 'Los Angeles Times', short: 'LA Times', outlets: ['los angeles times', 'la times', 'latimes.com'],
    feeds: ['https://www.latimes.com/world-nation/rss2.0.xml'], mail: ['latimes.com'],
  },
];

const DETECTED_FILE = path.join(ROOT, 'news-detected.json');

function readSettingsRaw() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8').replace(/^﻿/, '')); } catch (_) { return {}; }
}

function subscriptions() {
  const raw = readSettingsRaw();
  return new Set((Array.isArray(raw.subscriptions) ? raw.subscriptions : []).map(String).filter((id) => CATALOG.some((c) => c.id === id)));
}

function setSubscription(id, on) {
  if (!CATALOG.some((c) => c.id === id)) throw new Error('Unknown paper.');
  const raw = readSettingsRaw();
  const subs = new Set(Array.isArray(raw.subscriptions) ? raw.subscriptions : []);
  if (on) subs.add(id); else subs.delete(id);
  raw.subscriptions = [...subs];
  raw._subscriptions_note = raw._subscriptions_note || 'Papers you subscribe to. Set from the News page. Their links come first and are marked as yours.';
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
  // Deciding either way settles the suggestion.
  const det = loadDetected();
  if (det.papers[id]) { det.papers[id].settled = true; saveDetected(det); }
  return [...subs];
}

function loadDetected() {
  try {
    const d = JSON.parse(fs.readFileSync(DETECTED_FILE, 'utf8'));
    return { papers: d.papers || {}, checked: d.checked || {} };
  } catch (_) { return { papers: {}, checked: {} }; }
}

function saveDetected(d) {
  try {
    const tmp = `${DETECTED_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
    fs.renameSync(tmp, DETECTED_FILE);
  } catch (_) {}
}

function dismissDetected(id) {
  const det = loadDetected();
  if (det.papers[id]) det.papers[id].settled = true;
  saveDetected(det);
}

const SUBSCRIPTION_SUBJECT = /subscri|membership|receipt|renew|payment|billing|your (digital )?account|welcome to|free trial|your order|thank you for (joining|subscribing)/i;

/**
 * Looks through one inbox, at most once a day, for emails from a paper about
 * a subscription: receipts, renewals, welcome emails. Only which paper and
 * when are kept - never the subject or the message. It suggests; you decide.
 */
async function detectFromMail(api, account, now = new Date()) {
  const det = loadDetected();
  const last = det.checked[account];
  if (last && now - new Date(last) < 86400000) return null;
  const domains = CATALOG.flatMap((c) => c.mail);
  const ids = await api.listMessageIds(`from:(${domains.join(' OR ')}) newer_than:400d`, 40);
  for (const id of ids) {
    const msg = await api.getMessageMetadata(id, ['From', 'Subject']);
    const headers = (msg.payload && msg.payload.headers) || [];
    const from = String((headers.find((h) => /^from$/i.test(h.name)) || {}).value || '').toLowerCase();
    const subject = String((headers.find((h) => /^subject$/i.test(h.name)) || {}).value || '');
    if (!SUBSCRIPTION_SUBJECT.test(subject)) continue;
    const paper = CATALOG.find((c) => c.mail.some((dm) => new RegExp(`[@.]${dm.replace(/\./g, '\\.')}>?$`).test(from.replace(/[>\s]+$/, ''))));
    if (!paper) continue;
    const at = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : now.toISOString();
    const prev = det.papers[paper.id];
    if (!prev || prev.lastSeen < at) det.papers[paper.id] = { ...(prev || {}), lastSeen: at, settled: prev ? !!prev.settled : false };
  }
  det.checked[account] = now.toISOString();
  saveDetected(det);
  return det;
}

function loadPapers() {
  const raw = readSettingsRaw();
  const subs = subscriptions();
  const base = (Array.isArray(raw.papers) && raw.papers.length ? raw.papers : DEFAULT_PAPERS)
    .filter((p) => p && p.id && Array.isArray(p.feeds) && p.feeds.length && !p.disabled);
  const list = base.map((p) => ({ ...p }));
  for (const id of subs) {
    if (!list.some((p) => p.id === id)) list.push({ ...CATALOG.find((c) => c.id === id) });
  }
  // Yours first: that order is the order of the "Read in" buttons.
  return list.map((p) => ({ ...p, subscribed: subs.has(p.id) }))
    .sort((a, b) => (a.subscribed === b.subscribed ? 0 : a.subscribed ? -1 : 1));
}

function subscriptionStatus() {
  const subs = subscriptions();
  const det = loadDetected();
  return {
    catalog: CATALOG.map((c) => ({ id: c.id, name: c.name, short: c.short, subscribed: subs.has(c.id) })),
    suggested: Object.entries(det.papers)
      .filter(([id, v]) => !v.settled && !subs.has(id))
      .map(([id, v]) => ({ id, name: (CATALOG.find((c) => c.id === id) || {}).name || id, lastSeen: v.lastSeen })),
  };
}

const STOP = new Set(('the a an and or but of to in on for with at by from as is are was were be been has have had it its this that ' +
  'these those after before over under into about than more most new news says said say will would could can not no amid how ' +
  'why what who when where while his her their our your he she they we you just still now first last amp').split(' '));

function significantWords(text) {
  return new Set(String(text || '').toLowerCase().replace(/[’'`]/g, '')
    .split(/[^a-z0-9$%]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}

/**
 * Is this paper's item the same story? Compared by the distinctive words the
 * headlines share: three or more, or two when that is most of a short headline.
 * Loose enough for "Trump Resists AI Slowdown" and "White House Pushes Back on
 * AI Pause", strict enough that two stories about Congress do not match.
 */
function sameStory(storyWords, item) {
  const itemWords = significantWords(`${item.title} ${String(item.summary || '').slice(0, 200)}`);
  let shared = 0;
  for (const w of storyWords) if (itemWords.has(w)) shared++;
  const ofStory = shared / Math.max(1, Math.min(storyWords.size, 8));
  return (shared >= 3 && ofStory >= 0.34) || (shared >= 2 && ofStory >= 0.5) ? ofStory + shared / 100 : 0;
}

/**
 * Stories from one feed, from the cache when it has any. An empty cache is
 * filled before answering; an old one is refreshed behind the answer, or
 * before it when force is set.
 */
async function feedStories(id, url, opts = {}) {
  const pseudo = { id, url };
  const maxStories = opts.maxStories || 40;
  let data = readCache(id);
  const tried = data && (data.lastTriedAt || data.fetchedAt);
  const age = tried ? (Date.now() - new Date(tried).getTime()) / 60000 : Infinity;
  if (!data || !data.stories || !data.stories.length) {
    if (age > 1) data = await refresh(pseudo, { maxStories });
  } else if (opts.force && age > 1) {
    data = await refresh(pseudo, { maxStories });
  } else if (age >= (opts.maxAgeMinutes || 30)) {
    refresh(pseudo, { maxStories }).catch(() => {});
  }
  return { stories: (data && data.stories) || [], fetchedAt: (data && data.fetchedAt) || null, error: (data && data.lastError) || null };
}

async function paperItems(paper, force) {
  const items = [];
  const seen = new Set();
  await Promise.all(paper.feeds.map(async (url, i) => {
    const pseudo = { id: `paper-${paper.id}-${i}`, url };
    let data = readCache(pseudo.id);
    const tried = data && (data.lastTriedAt || data.fetchedAt);
    const age = tried ? (Date.now() - new Date(tried).getTime()) / 60000 : Infinity;
    if (!data || !data.stories || !data.stories.length) {
      if (age > 1) data = await refresh(pseudo, { maxStories: 40 });
    } else if (age >= 30 || (force && age > 1)) {
      refresh(pseudo, { maxStories: 40 }).catch(() => {});
    }
    paper.lists = paper.lists || [];
    paper.lists[i] = (data && data.stories) || [];
  }));
  for (const list of paper.lists || []) {
    for (const s of list) {
      if (seen.has(s.link)) continue;
      seen.add(s.link);
      items.push(s);
    }
  }
  return items;
}

/** Links to each paper's own version of a story, if it has one. */
function readingLinks(story, papers) {
  const storyWords = significantWords(story.title);
  const out = [];
  for (const p of papers) {
    let best = null;
    for (const item of p.items) {
      const score = sameStory(storyWords, item);
      if (score && (!best || score > best.score)) best = { score, item };
    }
    if (best) {
      out.push({
        id: p.id, name: p.name, short: p.short, title: best.item.title, link: best.item.link, subscribed: !!p.subscribed,
        summary: best.item.summary || '', image: best.item.image || '', publishedAt: best.item.publishedAt || null,
      });
      continue;
    }
    // Google's own coverage list sometimes names the paper when its feed does not.
    const outlets = (p.outlets || []).map((o) => o.toLowerCase());
    const covered = [{ outlet: story.outlet, link: story.link, title: story.title }, ...(story.related || [])]
      .find((r) => outlets.includes(String(r.outlet || '').toLowerCase()));
    if (covered) out.push({ id: p.id, name: p.name, short: p.short, title: covered.title, link: covered.link, subscribed: !!p.subscribed });
  }
  return out;
}

/**
 * The ranking for one source. Answers from the cache whenever it has one and
 * refreshes behind it when it is old, so a slow Google never slows the page.
 */
async function getNews(sourceId, opts = {}) {
  const settings = loadSettings();
  const source = settings.sources.find((s) => s.id === sourceId)
    || settings.sources.find((s) => s.id === settings.defaultSource)
    || settings.sources[0];
  const sources = settings.sources.map((s) => ({ id: s.id, name: s.name || s.id, label: s.label || s.name || s.id }));
  if (!source) return { source: null, sources, stories: [], error: 'No news sources in news.json.' };

  let data = readCache(source.id);
  const lastTried = data && (data.lastTriedAt || data.fetchedAt);
  const ageMin = lastTried ? (Date.now() - new Date(lastTried).getTime()) / 60000 : Infinity;
  // A refresh button held down should not become a stream of requests to Google.
  const force = !!opts.force && ageMin > 1;

  if (!data || !data.stories || !data.stories.length) {
    if (ageMin > 1) data = await refresh(source, settings);
  } else if (ageMin >= settings.refreshMinutes || force) {
    const pending = refresh(source, settings);
    if (force) data = await pending;
    else pending.catch(() => {});
  }

  data = data || { stories: [] };

  // The papers are a bonus. If they cannot be reached, the ranking still goes out.
  const papers = loadPapers();
  try {
    await Promise.all(papers.map(async (p) => { p.items = await paperItems(p, force); }));
  } catch (_) {
    papers.forEach((p) => { p.items = p.items || []; });
  }

  const bigTwo = new Set(['nyt', 'wsj']);
  const stories = (data.stories || []).slice(0, settings.maxStories).map((s) => {
    const readIn = readingLinks(s, papers);
    // Leading both the Times and the Journal at once is as close to "this
    // matters" as a feed gets. Other papers you add do not change that bar.
    return { ...s, readIn, major: readIn.filter((r) => bigTwo.has(r.id)).length >= 2 && s.rank <= 10 };
  });

  return {
    source: { id: source.id, name: source.name || source.id, ranking: source.ranking || '', home: source.home || '' },
    sources,
    fetchedAt: data.fetchedAt || null,
    error: data.lastError || null,
    refreshMinutes: settings.refreshMinutes,
    stories,
    // Each paper's own top of the page: the first items of its first feed.
    papers: papers.map((p) => ({ id: p.id, name: p.name, short: p.short, subscribed: !!p.subscribed, top: ((p.lists || [])[0] || []).slice(0, 5) })),
    subscriptions: subscriptionStatus(),
  };
}

module.exports = {
  loadSettings, loadPapers, parseFeed, decodeEntities, imageOf, getNews, feedStories, significantWords, sameStory, readingLinks,
  CATALOG, subscriptions, setSubscription, subscriptionStatus, detectFromMail, dismissDetected, SUBSCRIPTION_SUBJECT,
  DEFAULT_SOURCES, DEFAULT_PAPERS, SETTINGS_FILE, CACHE_DIR,
};
