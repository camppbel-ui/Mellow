'use strict';
/**
 * replies.js - is this email thread waiting on you?
 *
 * "Answer emails" as a daily chore is unfalsifiable: you click Done and
 * nothing checks. This asks the inbox instead. A thread is waiting on you when
 * the last message in it came from a real person, was addressed to you rather
 * than to a list you happen to be on, and is still in your inbox. Reply, or
 * archive it, and it stops counting on the next sync.
 */

const NO_REPLY = /(^|[^a-z])(no-?reply|do-?not-?reply|donotreply|notifications?|notify|mailer-daemon|postmaster|bounce[sd]?|alerts?|automated|system|support-noreply)([^a-z]|$)/i;

const SKIP_CATEGORIES = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];

// Calendar invitations are answered with a Yes/No button, not an email, and
// "Reminder:" or "FYI" says in the subject that nothing is being asked.
const NOT_A_CONVERSATION = /^\s*((updated\s+)?invitation(\s+from\s+google\s+calendar)?\s*:|(accepted|declined|tentatively\s+accepted|canceled|cancelled)\s*(event)?\s*:|new\s+event\s*:|event\s+reminder|reminder\s*:|fyi\b|announcement\s*:|newsletter|weekly\s+(update|digest))/i;

// Phrasing that asks something of you. A question mark is the strongest
// signal; the rest are the ways people ask without using one.
const ASKS_SOMETHING = /\?|\b(let\s+me\s+know|let\s+us\s+know|can\s+you|could\s+you|would\s+you|will\s+you|are\s+you\s+(free|available|able|coming|going)|do\s+you\s+(have|want|know)|please\s+(reply|respond|confirm|send|sign|fill|complete|rsvp|get\s+back)|rsvp|get\s+back\s+to\s+me|your\s+thoughts|when\s+works|what\s+time\s+works|looking\s+forward\s+to\s+hearing)\b/i;

// Sent to more people than this and it is an announcement, however personal
// the greeting sounds.
const MAX_RECIPIENTS = 6;

function addressOf(header) {
  const m = /<([^>]+)>/.exec(String(header || ''));
  return (m ? m[1] : String(header || '')).trim().toLowerCase();
}

function addressesIn(header) {
  return String(header || '')
    .split(',')
    .map((part) => addressOf(part))
    .filter((a) => a.includes('@'));
}

/**
 * `thread` is the normalised shape produced by sync.js:
 *   { id, subject, messages: [{ id, from, to, cc, date, labels, bulk, autoSubmitted }] }
 *
 * `me` is every address that counts as you on that account.
 *
 * Returns { waiting, since, from, subject, reason }. `reason` says why a thread
 * was skipped, which is what makes a wrong answer debuggable later.
 */
function awaitingReply(thread, me) {
  const mine = new Set((Array.isArray(me) ? me : [me]).map((a) => String(a).toLowerCase()));
  const messages = (thread.messages || [])
    .slice()
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const no = (reason) => ({ waiting: false, reason });
  if (!messages.length) return no('empty thread');

  const inInbox = messages.some((m) => (m.labels || []).includes('INBOX'));
  if (!inInbox) return no('archived');

  const last = messages[messages.length - 1];
  const lastFrom = addressOf(last.from);

  if (mine.has(lastFrom) || (last.labels || []).includes('SENT')) return no('you replied last');
  if ((last.labels || []).some((l) => SKIP_CATEGORIES.includes(l))) return no('not primary');
  if (last.bulk) return no('mailing list or newsletter');
  if (last.autoSubmitted) return no('automated');
  if (NO_REPLY.test(lastFrom.split('@')[0])) return no('no-reply sender');
  if (/instructure\.com|canvaslms\.com|gradescope\.com|piazza\.com|edstem\.org/i.test(lastFrom)) {
    return no('course site notification');
  }

  // Sent to a class list you are on, rather than to you, is an announcement.
  // You have to be on the To line - or have already been part of the
  // conversation - for silence to count as not replying.
  const directlyToMe = addressesIn(last.to).some((a) => mine.has(a));
  const iWroteEarlier = messages.some((m) => mine.has(addressOf(m.from)));
  if (!directlyToMe && !iWroteEarlier) return no('not addressed to you');

  if (NOT_A_CONVERSATION.test(thread.subject || '')) return no('invitation or announcement');

  const recipients = addressesIn(last.to).length + addressesIn(last.cc).length;
  if (recipients > MAX_RECIPIENTS && !iWroteEarlier) return no('sent to a crowd');

  // Being written to is not the same as being asked. Unless you were already
  // in the conversation, the message has to actually ask you something, or
  // every "here are the itineraries" email becomes a chore.
  if (!iWroteEarlier && !ASKS_SOMETHING.test(`${thread.subject || ''} ${last.snippet || ''}`)) {
    return no('does not ask you anything');
  }

  const since = new Date(last.date);
  if (Number.isNaN(since.getTime())) return no('no date');

  return {
    waiting: true,
    since,
    from: last.from || '',
    subject: thread.subject || '',
    reason: 'waiting on you',
  };
}

module.exports = { awaitingReply, addressOf, addressesIn, NO_REPLY, ASKS_SOMETHING, NOT_A_CONVERSATION };
