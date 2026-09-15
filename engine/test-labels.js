'use strict';
/**
 * test-labels.js - calendar labels (Class, Office hours, Practice... Required
 * or Optional) and noticing the groups you are in. Written to a temporary
 * folder, so your groups.json is never touched; nothing goes to the network.
 *
 *   node test-labels.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RATCHET_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-labels-'));

const labels = require('./lib/labels');
const groups = require('./lib/groups');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}

console.log('\nLabels');
{
  const courses = labels.coursesIn(['Intl Politics — Realism I', 'Intl Politics — Terrorism', 'GOV 211 — Republic']);
  const saac = { name: 'SAAC', aliases: ['Student-Athlete Advisory Committee'], kind: 'club', attend: 'required' };
  const ctx = { courses, groups: [saac], overrides: {} };
  const l = (title, extra) => labels.classify({ title, ...(extra || {}) }, ctx);

  check('a course session is a class you have to attend', l('ECO112 — Supply and Demand').type === 'class' && l('ECO112 — Supply and Demand').attend === 'required');
  check('a course without a code is still a class once it repeats', l('Intl Politics — Nuclear Weapons I').type === 'class');
  check('an in-class exam is an exam', l('Intl Politics — IN-CLASS EXAM #1').type === 'exam');
  check('review before a midterm is not the midterm', l('ECO112 — Review — Midterm I prep').type === 'class');
  check('office hours are optional', l('Prof. Lee office hours').type === 'office_hours' && l('Prof. Lee office hours').attend === 'optional');
  check('OH in capitals is office hours', l('ECO 112 OH').type === 'office_hours');
  check('practice is required', l('Swim practice').type === 'practice' && l('Swim practice').attend === 'required');
  check('a group meeting carries the group', l('SAAC Meeting').type === 'meeting' && l('SAAC Meeting').group === 'SAAC');
  check('a group social is optional', l('SAAC Halloween x Pickleball Night!').attend === 'optional' && l('SAAC Dodgeball Tournament').type === 'social');
  check('"mandatory" makes a meeting required', l('Mandatory Pre-participation Sports Medicine Meeting for Student-Athletes').attend === 'required');
  check('"optional" wins over the kind', l('Team lift (optional)').attend === 'optional');
  check('a holiday has no attendance', l('Labor Day', { calendar: 'Holidays in United States' }).type === 'holiday' && l('Labor Day', { calendar: 'Holidays in United States' }).attend === null);
  check('a train is travel', l('Train to New London CT').type === 'travel');
  check('a short name only matches as a whole word', labels.groupFor('Saacharine tasting', [saac]) === null);

  ctx.overrides[labels.titleKey('SAAC Meeting #3')] = { attend: 'optional' };
  check('your choice holds for every entry with that title, whatever its number', l('SAAC Meeting #4').attend === 'optional' && l('SAAC Meeting #4').by === 'you');
}

console.log('\nNoticing groups');
{
  check('an acronym next to ordinary words is a name', groups.acronymsIn('SAAC Meeting').join() === 'SAAC');
  check('a course code is not', groups.acronymsIn('ECO 112 — Taxes').length === 0);
  check('nor a word in a shouted headline', groups.acronymsIn('GOV 211 — FIRST PAPER ASSIGNED').length === 0);
  check('nor a common one', groups.acronymsIn('RSVP by Friday, DUE soon').length === 0);
  check('a full name is found in a sentence', groups.phrasesIn('Welcome to the Student-Athlete Advisory Committee!').join() === 'Student-Athlete Advisory Committee');

  const state = groups.load();
  const events = ['SAAC Meeting', 'SAAC Meeting', 'SAAC 5K Run/Walk', 'ECO112 — Taxes', 'Intl Politics — IN-CLASS EXAM #1', 'Labor Day']
    .map((title) => ({ title, calendar: title === 'Labor Day' ? 'Holidays in United States' : 'Class' }));
  const r = groups.observe(state, groups.signalsFromEvents(events));
  const saac = state.groups.find((g) => g.id === 'saac');
  check('a name that keeps coming up on the calendar is suggested', saac && saac.status === 'suggested' && r.became.includes(saac));
  check('a weekly meeting counts once, not every week', saac.calendarCount === undefined && Object.keys(saac.refs).length === 2);
  check('nothing else on that calendar is', state.groups.filter((g) => g.status === 'suggested').length === 1);

  groups.observe(state, groups.signalsFromEmail({ id: 'm1', subject: 'Welcome to the Student-Athlete Advisory Committee', from: 'Athletics <a@conncoll.edu>', labels: [] }));
  check('its full name, from an email, joins the short name rather than starting a second group', saac.aliases.includes('Student-Athlete Advisory Committee') && !state.groups.some((g) => g.id === 'student-athlete-advisory-committee'));

  groups.observe(state, groups.signalsFromEmail({ id: 'm2', subject: '[CCIB] Pitch night', from: 'CCIB <ccib@conncoll.edu>', labels: ['CATEGORY_PROMOTIONS'] }));
  check('promotions are ignored', !state.groups.some((g) => g.id === 'ccib'));

  groups.decide(state, 'saac', true);
  check('saying yes makes it one of your groups', groups.summary(state).joined.some((g) => g.name === 'SAAC') && !groups.summary(state).suggested.length);
  groups.save(state);
  check('and it is saved', groups.load().groups.find((g) => g.id === 'saac').status === 'joined');

  const other = groups.load();
  groups.observe(other, groups.signalsFromEvents([{ title: 'CCIB | Meeting #1' }]));
  groups.decide(other, 'ccib', false);
  groups.observe(other, groups.signalsFromEvents([{ title: 'CCIB | Meeting #2' }, { title: 'CCIB pitch night' }]));
  check('saying no is for good', other.groups.find((g) => g.id === 'ccib').status === 'dismissed');

  groups.setLabel(other, 'SAAC Meeting', { attend: 'optional' });
  check('a label choice is kept by title', other.overrides[labels.titleKey('SAAC Meeting')].attend === 'optional');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
