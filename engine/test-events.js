'use strict';
/**
 * test-events.js - finding appointments in email, and the stock and news
 * helpers that sit beside them.
 *
 *   node test-events.js
 */

const events = require('./lib/extract/events');
const autotasks = require('./lib/autotasks');
const stocks = require('./lib/stocks');
const news = require('./lib/news');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

/* Monday 2026-09-14, 9am. */
const NOW = new Date(2026, 8, 14, 9, 0);
const mail = (subject, body, extra = {}) => ({
  id: extra.id || 'm1', threadId: 't1', subject, from: extra.from || 'Dana Reyes <dana@example.com>',
  date: extra.date || NOW, body, labels: extra.labels || ['INBOX'], bulk: !!extra.bulk,
});

console.log('\nFinding events');
{
  const c = events.fromEmail(mail('Interview with Acme', 'Hi Campbell,\n\nYour interview is confirmed for Thursday, September 17 at 2:00 PM.\nLocation: 500 Main St, Suite 4\n\nThanks'), 'me@x.com', NOW);
  check('an interview with a date and time is found', !!c);
  check('it starts at the right moment', c && c.start.getDate() === 17 && c.start.getHours() === 14);
  check('an hour long when no end is given', c && c.end - c.start === 3600000);
  check('the subject is the title', c && c.title === 'Interview with Acme');
  check('Location: is read', c && c.location === '500 Main St, Suite 4');
  check('the key is stable for the day', c && c.key === 'ev::interview-with-acme::2026-09-17');
}
{
  const c = events.fromEmail(mail('Re: Hi', 'Want to grab coffee tomorrow at 10am? zoom.us/j/123 works too'), 'me@x.com', NOW);
  check('a generic subject becomes "Coffee with <sender>"', c && c.title === 'Coffee with Dana Reyes');
  check('"tomorrow at 10am" is read', c && c.start.getDate() === 15 && c.start.getHours() === 10);
  check('a Zoom link reads as Zoom', c && c.location === 'Zoom');
}
{
  const c = events.fromEmail(mail('Club meeting moved', 'The meeting is now on 9/18 from 7-9pm in Room 204.'), 'me@x.com', NOW);
  check('a time range sets the end', c && c.start.getHours() === 19 && c.end.getHours() === 21);
}
check('no time, no event', !events.fromEmail(mail('Dinner', 'Dinner on Friday? Let me know.'), 'me@x.com', NOW));
check('no event word, no event', !events.fromEmail(mail('Report', 'Numbers are attached, due Friday at 5pm.'), 'me@x.com', NOW));
check('an event already over is ignored', !events.fromEmail(mail('Meeting', 'Our meeting on September 1 at 3pm went well.'), 'me@x.com', NOW));
check('a calendar invitation is left to the calendar', !events.fromEmail(mail('Invitation: Sync @ Thu Sep 17 2pm', 'meeting at 2pm Thursday', { from: 'Google Calendar <calendar-notification@google.com>' }), 'me@x.com', NOW));
check('a cancellation is not an event', !events.fromEmail(mail('Meeting cancelled', 'The meeting on Thursday at 2pm has been cancelled.'), 'me@x.com', NOW));
check('promotions are skipped', !events.fromEmail(mail('Join us!', 'Event Friday at 7pm', { labels: ['CATEGORY_PROMOTIONS'] }), 'me@x.com', NOW));
check('a quoted reply does not count', !events.fromEmail(mail('Re: thanks', 'Thanks!\n\nOn Mon, Sep 7, 2026 at 3:14 PM Dana wrote:\n> meeting Thursday at 2pm'), 'me@x.com', NOW));

console.log('\nSaving suggestions');
{
  const state = autotasks.empty();
  const c = events.fromEmail(mail('Interview with Acme', 'Your interview is confirmed for Thursday, September 17 at 2:00 PM.'), 'me@x.com', NOW);
  autotasks.mergeEvents(state, [c], NOW);
  check('a new event arrives unconfirmed', state.events[c.key] && !state.events[c.key].confirmed);
  const moved = events.fromEmail(mail('Interview with Acme', 'Update: your interview is confirmed for Thursday, September 17 at 3:00 PM.', { id: 'm2', date: new Date(2026, 8, 14, 12) }), 'me@x.com', NOW);
  autotasks.mergeEvents(state, [moved], NOW);
  check('a newer email moves it', new Date(state.events[c.key].start).getHours() === 15);
  autotasks.setEvent(state, c.key, { dismissed: true });
  const again = events.fromEmail(mail('Interview with Acme', 'Reminder: interview confirmed for Thursday, September 17 at 4:00 PM.', { id: 'm3', date: new Date(2026, 8, 15, 8) }), 'me@x.com', NOW);
  autotasks.mergeEvents(state, [again], NOW);
  check('a dismissed one stays dismissed and unchanged', state.events[c.key].dismissed && new Date(state.events[c.key].start).getHours() === 15);
  autotasks.mergeEvents(state, [], new Date(2026, 8, 20));
  check('an undecided suggestion is forgotten once it is over', !state.events[c.key] || state.events[c.key].dismissed);
}

console.log('\nStocks');
{
  const body = JSON.stringify({ chart: { result: [{ meta: {
    symbol: 'NKE', shortName: 'Nike, Inc.', currency: 'USD', regularMarketPrice: 36.8, chartPreviousClose: 36.62, regularMarketTime: 1789156800,
    currentTradingPeriod: { regular: { start: 1789133400, end: 1789156800 } },
  }, indicators: { quote: [{ close: [36.6, null, 36.7, 36.8] }] } }] } });
  const q = stocks.parseChart(body, new Date(1789160000 * 1000));
  check('price and name', q.price === 36.8 && q.name === 'Nike, Inc.');
  check('change against the previous close', Math.abs(q.change - 0.18) < 1e-9 && Math.abs(q.changePercent - 0.4915) < 0.001);
  check('after the close reads as not open', q.session !== 'open');
  check('the sparkline skips gaps', q.spark.length >= 2 && q.spark.every((x) => typeof x === 'number'));
  check('tickers only from settings', stocks.loadSettings().symbols.every((s) => /^[A-Z0-9.^=-]+$/.test(s)));
}

console.log('\nThe Times and the Journal');
{
  const story = { title: 'Indonesia rescuers battle turbulent seas in search for 129 people after passenger ship capsizes', outlet: 'BBC', related: [] };
  const papers = [
    { id: 'nyt', name: 'NYT', short: 'NYT', outlets: ['the new york times'], items: [
      { title: 'More Than 120 Unaccounted for After Ferry Sinks in Indonesia', summary: 'Rescuers searched rough seas after a passenger ship capsized.', link: 'https://nytimes.com/a' },
      { title: 'Congress Returns to a Crowded Agenda', summary: '', link: 'https://nytimes.com/b' },
    ] },
    { id: 'wsj', name: 'WSJ', short: 'WSJ', outlets: ['wsj'], items: [{ title: 'Oil Prices Rise', summary: '', link: 'https://wsj.com/c' }] },
  ];
  const links = news.readingLinks(story, papers);
  check('the same story is found in the Times', links.length === 1 && links[0].link === 'https://nytimes.com/a');
  check('an unrelated Journal story is not linked', !links.some((l) => l.id === 'wsj'));
  const viaCoverage = news.readingLinks({ title: 'Something else entirely here', outlet: 'Axios', related: [{ outlet: 'WSJ', link: 'https://news.google.com/w', title: 'x' }] }, papers);
  check("Google's coverage list is used when the feed has nothing", viaCoverage.some((l) => l.id === 'wsj' && l.link === 'https://news.google.com/w'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
