'use strict';
/**
 * events.js - find the appointments in your email: the interview on Thursday
 * at 2, the dinner reservation, the club meeting moved to 7pm.
 *
 * Same temperament as homework.js. It would rather miss an event than invent
 * one, so it needs three things together: a word that says this is a thing
 * you attend, a date, and a time, sitting close to each other in the same
 * message. Whatever it finds is only a suggestion. Nothing reaches your
 * calendar until you press Add.
 */

const { findDates, stripQuoted } = require('./dates');

const EVENT_EXTRACT_VERSION = 1;

// Words that mean "be somewhere at a time".
const EVENT_WORDS = /\b(meeting|meet(?:\s+up)?|appointment|appt|interview|call|zoom|google\s+meet|teams\s+meeting|office\s+hours|dinner|lunch|breakfast|brunch|coffee|drinks|reservation|reserved|booking|booked|flight|departs?|boarding|check-?in|event|party|celebration|rehearsal|practice|game|match|concert|show|screening|session|workshop|seminar|talk|lecture|info\s+session|orientation|tour|visit|consultation|haircut|dentist|doctor|rsvp|join\s+us|see\s+you|scheduled\s+for|confirmed\s+for|starts?\s+at|begins?\s+at|doors\s+open)\b/gi;

// Mail that talks about an event without being one you are going to.
const NOT_AN_EVENT = /\b(unsubscribe|webinar\s+recording|recording\s+(?:is\s+)?(?:now\s+)?available|missed\s+(?:the|our)|recap|cancel+ed|has\s+been\s+cancel+ed|no\s+longer|rescheduled\s+to\s+tbd|receipt|order\s+(?:confirmation|shipped)|your\s+package|delivery|invoice|payment\s+due|statement)\b/i;

// Google and Outlook invitations are already on the calendar once you accept.
const CALENDAR_SENDER = /calendar-notification@google\.com|noreply@google\.com|outlook\.com.*calendar/i;
const INVITE_SUBJECT = /^(invitation|updated\s+invitation|accepted|declined|tentatively\s+accepted|canceled\s+event|cancelled\s+event)\s*:/i;

function cleanSubject(s) {
  return String(s || '')
    .replace(/^\s*((re|fwd?|fw)\s*:\s*)+/i, '')
    .replace(/^\s*\[[^\]]{1,40}\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function senderName(from) {
  const m = /^\s*"?([^"<]+?)"?\s*</.exec(String(from || ''));
  return (m ? m[1] : String(from || '').split('@')[0]).trim();
}

/** "3-5pm", "from 3pm to 5pm", "3:00 – 4:30 PM": an end time after a start. */
function findEnd(text, index, start) {
  const after = text.slice(index, index + 60);
  const m = /(?:-|–|—|\bto\b|\buntil\b|\btill\b)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i.exec(after);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  const mi = m[2] ? parseInt(m[2], 10) : 0;
  const pm = m[3] ? /^p/i.test(m[3]) : start.getHours() >= 12 || h < start.getHours() % 12;
  if (pm) h += 12;
  const end = new Date(start);
  end.setHours(h, mi, 0, 0);
  if (end <= start || end - start > 12 * 3600000) return null;
  return end;
}

function findLocation(text) {
  let m = /\b(?:location|where|venue|address|place)\s*:\s*([^\n]{3,80})/i.exec(text);
  if (m) return m[1].trim().replace(/[.,;]\s*$/, '');
  m = /\b(zoom\.us\/j\/\S+|meet\.google\.com\/\S+|teams\.microsoft\.com\/\S+)/i.exec(text);
  if (m) return /zoom/i.test(m[1]) ? 'Zoom' : /meet\.google/i.test(m[1]) ? 'Google Meet' : 'Teams';
  m = /\b(?:in|at)\s+((?:room|rm\.?|hall|building|bldg\.?)\s+[A-Z0-9][\w-]{0,10}|[A-Z][a-z]+\s+(?:Hall|Center|Library|Building|Room|Cafe|Café|Restaurant|Theater|Theatre|Auditorium)(?:\s+\d{1,4})?)/.exec(text);
  return m ? m[1].trim() : '';
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').slice(0, 6).join('-');
}

function dayKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * An event suggestion from one email, or null.
 *
 * msg: { id, threadId, subject, from, date, body, labels, bulk }
 */
function fromEmail(msg, account, now = new Date()) {
  if (!msg) return null;
  if (CALENDAR_SENDER.test(msg.from || '') || INVITE_SUBJECT.test(msg.subject || '')) return null;
  const labels = msg.labels || [];
  if (labels.includes('SENT') || labels.includes('CATEGORY_PROMOTIONS') || labels.includes('CATEGORY_SOCIAL')) return null;

  const subject = cleanSubject(msg.subject);
  const body = stripQuoted(msg.body || msg.snippet || '').slice(0, 6000);
  const text = `${subject}\n${body}`;
  if (NOT_AN_EVENT.test(subject) || (msg.bulk && NOT_AN_EVENT.test(body))) return null;

  const reference = msg.date instanceof Date && !Number.isNaN(msg.date.getTime()) ? msg.date : now;
  const words = [];
  let m;
  EVENT_WORDS.lastIndex = 0;
  while ((m = EVENT_WORDS.exec(text))) words.push({ index: m.index, word: m[0].toLowerCase() });
  if (!words.length) return null;

  // Only a date with a time, near an event word, in the future, within two months.
  let best = null;
  for (const d of findDates(text, reference)) {
    if (!d.hasTime) continue;
    if (d.date.getTime() < now.getTime() - 3600000 || d.date.getTime() > now.getTime() + 60 * 86400000) continue;
    let distance = Infinity, word = '';
    for (const w of words) {
      const gap = w.index <= d.index ? d.index - (w.index + w.word.length) : w.index - (d.index + d.length);
      if (gap >= 0 && gap < distance) { distance = gap; word = w.word; }
    }
    if (distance > 90) continue;
    if (!best || distance < best.distance) best = { ...d, distance, word };
  }
  if (!best) return null;

  let start = best.date;
  let end = null;
  // "9/18 from 7-9pm": the pm belongs to both, and the time finder alone would
  // read the start as 9pm.
  const range = /^[\s,]*(?:from|at)?\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|\bto\b|\buntil\b)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i
    .exec(text.slice(best.index + best.length, best.index + best.length + 40));
  if (range) {
    const hour = (h, mer) => (parseInt(h, 10) % 12) + (/^p/i.test(mer) ? 12 : 0);
    const s = new Date(start), e = new Date(start);
    s.setHours(hour(range[1], range[3] || range[6]), range[2] ? parseInt(range[2], 10) : 0, 0, 0);
    e.setHours(hour(range[4], range[6]), range[5] ? parseInt(range[5], 10) : 0, 0, 0);
    if (e > s) { start = s; end = e; }
  }
  end = end || findEnd(text, best.index + best.length, start) || new Date(start.getTime() + 3600000);
  const generic = !subject || subject.length < 4 || /^(hi|hello|hey|quick question|question|update|following up|follow up|checking in)\b/i.test(subject);
  const what = best.word.replace(/\s+/g, ' ');
  const title = generic
    ? `${what.charAt(0).toUpperCase() + what.slice(1)} with ${senderName(msg.from)}`
    : subject.slice(0, 90);

  return {
    key: `ev::${slug(title)}::${dayKey(start)}`,
    title,
    start,
    end,
    location: findLocation(body),
    source: {
      type: 'email',
      account,
      ref: msg.id,
      threadId: msg.threadId,
      from: msg.from || '',
      subject: msg.subject || '',
      at: reference.toISOString(),
      matched: text.slice(Math.max(0, best.index - 40), best.index + best.length + 30).replace(/\s+/g, ' ').trim(),
    },
  };
}

/** The Gmail search that finds candidates, so only likely mail is ever downloaded. */
function query(days) {
  return `newer_than:${days}d -category:promotions -category:social -in:sent -in:chats -from:calendar-notification@google.com ` +
    '{meeting appointment interview zoom "office hours" dinner lunch coffee reservation booking flight rsvp ' +
    '"see you" "scheduled for" "confirmed for" rehearsal practice workshop session event}';
}

module.exports = { fromEmail, query, cleanSubject, findEnd, findLocation, EVENT_EXTRACT_VERSION };
