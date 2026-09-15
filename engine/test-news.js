'use strict';
/**
 * test-news.js - the news feed parser.
 *
 * Fixtures are trimmed copies of what Google News and the BBC actually send,
 * so these run offline and never depend on today's headlines.
 *
 *   node test-news.js
 */

const news = require('./lib/news');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

const li = (href, title, outlet) =>
  `&lt;li&gt;&lt;a href="${href}" target="_blank"&gt;${title}&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;${outlet}&lt;/font&gt;&lt;/li&gt;`;

const GOOGLE = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<title>Top stories - Google News</title>
<item><title>Lawmakers Agree A.I.’s Risks Are Rising - The New York Times</title>
<link>https://news.google.com/rss/articles/AAA?oc=5</link>
<pubDate>Sun, 13 Sep 2026 20:49:16 GMT</pubDate>
<description>&lt;ol&gt;${li('https://news.google.com/a1', 'Lawmakers Agree A.I.’s Risks Are Rising', 'The New York Times')}${li('https://news.google.com/a2', 'A turning point for AI', 'cnn.com')}${li('https://news.google.com/a3', 'America&amp;#39;s AI Freakout', 'WSJ')}${li('https://news.google.com/a4', 'Four', 'CNBC')}${li('https://news.google.com/a5', 'Five', 'NPR')}&lt;/ol&gt;</description>
<source url="https://www.nytimes.com">The New York Times</source></item>
<item><title>Oman delays Hormuz meeting - Bloomberg.com</title>
<link>https://news.google.com/rss/articles/BBB?oc=5</link>
<pubDate>Sun, 13 Sep 2026 20:04:23 GMT</pubDate>
<description>&lt;ol&gt;${li('https://news.google.com/b1', 'Oman delays Hormuz meeting', 'Bloomberg.com')}${li('https://news.google.com/b2', 'Talks pushed back', 'Reuters')}&lt;/ol&gt;</description>
<source url="https://www.bloomberg.com">Bloomberg.com</source></item>
<item><title>No link on this one</title><link>javascript:alert(1)</link></item>
</channel></rss>`;

const BBC = `<?xml version="1.0" encoding="UTF-8"?><rss><channel>
<title><![CDATA[BBC News]]></title>
<item><title><![CDATA[Committee calls for bill on AI & rights]]></title>
<description><![CDATA[A cross-party group of MPs identifies <b>risks</b>.]]></description>
<link>https://www.bbc.co.uk/news/articles/c1</link>
<pubDate>Mon, 14 Sep 2026 04:10:00 GMT</pubDate></item>
<item><title><![CDATA[Second story]]></title>
<link>https://www.bbc.co.uk/news/articles/c2</link></item>
</channel></rss>`;

console.log('\nGoogle News');
{
  const s = news.parseFeed(GOOGLE);
  check('two stories, the one with a javascript: link is dropped', s.length === 2);
  check('feed order is the ranking', s[0].rank === 1 && s[1].rank === 2 && /Lawmakers/.test(s[0].title));
  check('" - Outlet" is taken off the headline', s[0].title === 'Lawmakers Agree A.I.’s Risks Are Rising');
  check('outlet comes from <source>', s[0].outlet === 'The New York Times');
  check('outlets counts the whole coverage list', s[0].outlets === 5 && s[1].outlets === 2);
  check('five listed means five or more', s[0].outletsMore === true && s[1].outletsMore === false);
  check('related leaves out the story itself', s[0].related.length === 4 && s[0].related[0].outlet === 'cnn.com');
  check('double-encoded entities in related titles are decoded', s[0].related[1].title === "America's AI Freakout");
  check('pubDate becomes ISO', s[0].publishedAt === '2026-09-13T20:49:16.000Z');
  check('no summary when there is a coverage list', s[0].summary === '');
  check('max limits the count', news.parseFeed(GOOGLE, 1).length === 1);
}

console.log('\nBBC');
{
  const s = news.parseFeed(BBC);
  check('CDATA titles are read', s.length === 2 && s[0].title === 'Committee calls for bill on AI & rights');
  check('description becomes a plain-text summary', s[0].summary === 'A cross-party group of MPs identifies risks.');
  check('a story with no outlet list counts as one outlet', s[0].outlets === 1 && s[0].related.length === 0);
  check('missing pubDate is null, not Invalid Date', s[1].publishedAt === null);
}

console.log('\nPictures');
{
  const nyt = `<item><title>Ferry Sinks</title><link>https://www.nytimes.com/a</link>
    <media:content height="1350" medium="image" url="https://static01.nyt.com/big.jpg?quality=75&amp;auto=webp" width="1800"/>
    <media:content height="100" medium="image" url="https://static01.nyt.com/small.jpg" width="100"/></item>`;
  check('the largest media:content is used, entities decoded', news.imageOf(nyt) === 'https://static01.nyt.com/big.jpg?quality=75&auto=webp');
  check('a media:thumbnail counts', news.imageOf('<media:thumbnail width="240" url="https://ichef.bbci.co.uk/x.jpg"/>') === 'https://ichef.bbci.co.uk/x.jpg');
  check('a non-image enclosure does not', news.imageOf('<enclosure url="https://x.com/a.mp3" type="audio/mpeg"/>') === '');
  check('only http(s)', news.imageOf('<media:content medium="image" url="javascript:alert(1)"/>') === '');
  check('parseFeed carries the picture', news.parseFeed(`<rss><channel>${nyt}</channel></rss>`)[0].image.startsWith('https://static01.nyt.com/big.jpg'));
}

console.log('\nEntities');
check('numeric and named entities', news.decodeEntities('&#8217;&#x2014;&amp;&nbsp;&hellip;') === '’—& …');
check('unknown entities are left alone', news.decodeEntities('&bogus;') === '&bogus;');

console.log('\nSettings');
{
  const st = news.loadSettings();
  check('news.json has sources', st.sources.length >= 1 && st.sources.every((x) => x.id && x.url));
  check('refresh is never more often than every 5 minutes', st.refreshMinutes >= 5);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
