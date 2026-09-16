'use strict';
/**
 * test-grades.js - Grades: weighted averages, dropped scores, what you need on
 * the rest, GPA, a syllabus's grading breakdown and a screenshot of a grades
 * page arriving through Files, and the assistant logging a score. Claude is
 * replaced with a script and everything is written to a temporary folder, so
 * this runs offline and never touches your own grades.
 *
 *   node test-grades.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mellow-grades-'));
process.env.RATCHET_DATA_DIR = TMP;

const grades = require('./lib/grades');
const drops = require('./lib/drops');
const claude = require('./lib/ai/claude');
const assistant = require('./lib/ai/assistant');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}`); }
}
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const blank = () => ({ settings: { term: '', defaultTarget: 'A-', shareWithAi: true }, courses: [] });

async function scanned(id) {
  for (let i = 0; i < 100; i++) {
    const d = drops.getDrop(id);
    if (d && d.status !== 'scanning') return d;
    await sleep(20);
  }
  return drops.getDrop(id);
}

(async () => {
  const realMessages = claude.messages;
  const realUnavailable = claude.unavailable;
  try {
    console.log('\nA weighted course');
    {
      const data = blank();
      const c = grades.upsertCourse(data, { code: 'eco 112', name: 'Macroeconomics', credits: 4, target: 'B+', categories: [{ name: 'Exams', weight: 50 }, { name: 'Homework', weight: 30, drop: 1 }, { name: 'Participation', weight: 20 }] });
      const exams = c.categories[0].id, hw = c.categories[1].id;
      grades.upsertGrade(data, 'ECO112', { title: 'Midterm', score: 80, outOf: 100, category: exams });
      grades.upsertGrade(data, c.id, { title: 'Problem Set 1', score: 10, outOf: 10, category: hw });
      grades.upsertGrade(data, c.id, { title: 'Problem Set 2', score: 2, outOf: 10, category: hw });
      grades.upsertGrade(data, c.id, { title: 'Problem Set 3', score: 9, outOf: 10, category: hw });
      const s = grades.summarize(c, data.settings);
      const hwCat = s.categories.find((k) => k.name === 'Homework');
      check('the lowest homework is dropped once there are more than one', hwCat.count === 2 && hwCat.dropped === 1 && hwCat.percent === 95);
      // Exams 80 x 50 + Homework 95 x 30, over the 80% graded so far.
      check('the current grade weighs only what is graded', s.percent === 85.6 && s.letter === 'B');
      check('the range it can still finish in', s.min === 68.5 && s.max === 88.5);
      // B+ is 87: (87 x 100 - 6850) / 20 = 92.5 on participation.
      check('what the target needs on the rest', s.needed.percent === 92.5 && s.needed.status === 'stretch' && s.needed.leftWeight === 20);
      check('a course code is found however it is typed', grades.findCourse(data, 'ECO-112') === c && grades.findCourse(data, 'eco 112 macro') === c);

      // Now say how many there are: one exam of two, three problem sets of six (one dropped).
      grades.upsertCourse(data, { id: c.id, categories: [{ id: exams, name: 'Exams', weight: 50, count: 2 }, { id: hw, name: 'Homework', weight: 30, drop: 1, count: 6 }, { name: 'Participation', weight: 20 }] });
      const t = grades.summarize(data.courses[0], data.settings);
      check('the grade now still reads like Canvas', t.percent === 85.6 && t.letter === 'B');
      // Done: exams 25 of 50 weight, homework 15 of 30. Earned 25 x 80 + 15 x 95 = 3425.
      check('a part half done leaves half its weight to come', t.gradedWeight === 40 && t.earnedWeight === 3425 && t.min === 34.3 && t.max === 94.3);
      check('so B+ is within reach on the rest', t.needed.percent === 87.9 && t.needed.status === 'on-track' && t.needed.leftWeight === 60);
      check('and a part with scores but no count is flagged', t.uncounted === 0 && s.uncounted === 2);
      check('the same code cannot be added twice', throws(() => grades.upsertCourse(data, { code: 'ECO 112' }), /already in Grades/));
    }

    console.log('\nScores, checked');
    {
      const data = blank();
      const c = grades.upsertCourse(data, { code: 'BIO 101', categories: [{ name: 'Quizzes', weight: 20 }, { name: 'Exams', weight: 60 }, { name: 'Labs', weight: 20 }] });
      check('a bare percentage is out of 100', grades.validateGrade(c, { title: 'Quiz 1', score: 87 }).outOf === 100);
      check('a score far above what it is out of is a typo', throws(() => grades.validateGrade(c, { title: 'Quiz 2', score: 90, outOf: 10 }), /typo/));
      check('a score needs a title', throws(() => grades.validateGrade(c, { score: 5, outOf: 10 }), /Name the assignment/));
      check('a quiz finds the Quizzes category by itself', grades.validateGrade(c, { title: 'Quiz 3', score: 8, outOf: 10 }).category === c.categories[0].id);
      check('the final exam finds Exams', grades.validateGrade(c, { title: 'Final', score: 70, outOf: 100 }).category === c.categories[1].id);
      check('a named category wins over the title', grades.validateGrade(c, { title: 'Final', score: 9, outOf: 10, categoryName: 'lab' }).category === c.categories[2].id);
      check('"none" leaves it out of every category', grades.validateGrade(c, { title: 'Quiz 4', score: 9, outOf: 10, category: 'none' }).category === null);
      grades.upsertCourse(data, { code: 'MATH 10' });
      check('MATH 101 never finds MATH 10', grades.findCourse(data, 'MATH 101') === null && !!grades.findCourse(data, 'MATH 10'));
      grades.upsertCourse(data, { code: 'GOV 113' });
      grades.upsertCourse(data, { code: 'DAN 119' });
      check('a section or a cross-listed code finds its course', grades.findCourse(data, 'GOV 113-2').code === 'GOV 113' && grades.findCourse(data, 'AFR/CRE/DAN/REL 119').code === 'DAN 119' && grades.findCourse(data, 'bio101.1').code === 'BIO 101');
      check('but a lab section with its own letter is its own course', grades.findCourse(data, 'BIO 101L') === null);
    }

    console.log('\nNo categories, a custom scale, and GPA');
    {
      const data = blank();
      const a = grades.upsertCourse(data, { code: 'HIS 200', credits: 3, scale: [{ letter: 'A', min: 90 }, { letter: 'B', min: 80 }, { letter: 'C', min: 70 }] });
      check('a scale with no F gets one at zero', a.scale[a.scale.length - 1].letter === 'F' && a.scale[a.scale.length - 1].min === 0);
      grades.upsertGrade(data, a.id, { title: 'Essay', score: 45, outOf: 50 });
      grades.upsertGrade(data, a.id, { title: 'Response', score: 7, outOf: 10 });
      const sa = grades.summarize(a, data.settings);
      check('without weights it is points over points', sa.percent === 86.7 && sa.letter === 'B' && !sa.weighted && sa.needed === null);
      const b = grades.upsertCourse(data, { code: 'CS 150', credits: 4 });
      grades.upsertGrade(data, b.id, { title: 'Project', score: 95, outOf: 100 });
      const o = grades.overview(data);
      // B (3.0) x 3 + A (4.0) x 4 over 7 credits.
      check('GPA weighs each letter by credits', o.gpa === 3.57 && o.credits === 7);
      grades.upsertCourse(data, { id: b.id, archived: true });
      check('an archived course leaves the GPA', grades.overview(data).gpa === 3);
      grades.upsertGrade(data, a.id, { title: 'Excused quiz', score: 0, outOf: 10, excused: true });
      check('an excused score counts for nothing', grades.summarize(data.courses[0], data.settings).percent === 86.7);
    }

    console.log('\nA syllabus breakdown');
    {
      const data = blank();
      const c = grades.upsertCourse(data, { code: 'PSY 101' });
      grades.upsertGrade(data, c.id, { title: 'Midterm exam', score: 40, outOf: 50 });
      check('before a breakdown, a score has no category', data.courses[0].grades[0].category === null);
      const r = grades.applyGrading(data, { course: 'PSY101', courseName: 'Intro to Psychology', categories: [{ name: 'Exams', weight: 60 }, { name: 'Papers', weight: 40 }], scale: [] }, { type: 'file', ref: 'x' });
      check('the existing course is updated, not duplicated', !r.created && data.courses.length === 1 && r.course.name === 'Intro to Psychology');
      check('scores already there find their categories', r.course.grades[0].category === r.course.categories[0].id);
      const again = grades.applyGrading(data, { course: 'PSY 101', categories: [{ name: 'Exams', weight: 50 }, { name: 'Papers', weight: 50 }] });
      check('reading it again keeps category ids, so scores stay put', again.course.categories[0].id === r.course.categories[0].id && again.course.categories[0].weight === 50);
      const made = grades.applyGrading(data, { course: 'SOC 210', courseName: null, credits: 3, categories: [{ name: 'Final', weight: 100 }] });
      check('a new course is made from a syllabus, aimed at the default target', made.created && made.course.code === 'SOC 210' && made.course.credits === 3 && made.course.target === 'A-');
      check('a breakdown with nothing in it is refused', throws(() => grades.applyGrading(data, { course: 'X', categories: [] }), /no grading breakdown/));
      const clean = drops.cleanGrading({ course: 'ENG 1', categories: [{ name: 'Essays', weight: 70, drop: 0 }, { name: '', weight: 30 }, { name: 'Bogus', weight: 400 }], scale: [{ letter: 'a', min: 90 }, { letter: 'B', min: 80 }], credits: 99 });
      check('a scanned breakdown is tidied', clean.categories.length === 1 && clean.credits === null && clean.scale[0].letter === 'A' && clean.total === 70);
      check('weights of nothing are no breakdown', drops.cleanGrading({ categories: [{ name: 'A', weight: 0 }] }) === null);
    }

    console.log('\nThrough Files, with Claude replaced by a script');
    {
      claude.unavailable = () => null;
      const reply = (json) => async () => ({ content: [{ type: 'text', text: JSON.stringify(json) }], stop_reason: 'end_turn', usd: 0 });
      const blankItem = { course: null, date: null, startTime: null, endTime: null, location: null, amount: null, outOf: null, category: null, repeats: 'none', weekdays: [], until: null, notes: null, evidence: null, confidence: 'high', card: null };

      claude.messages = reply({
        title: 'CHM 110 Syllabus', folder: 'syllabus', summary: 'General chemistry.', highlights: [], documentKind: 'syllabus',
        grading: { course: 'CHM 110', courseName: 'General Chemistry', instructor: 'Dr. Ray', credits: 4, categories: [{ name: 'Exams', weight: 45, drop: null }, { name: 'Labs', weight: 25, drop: 1 }, { name: 'Quizzes', weight: 30, drop: 2 }], scale: [] },
        items: [{ ...blankItem, kind: 'exam', title: 'Exam 1', course: 'CHM 110', date: '2026-10-02' }],
      });
      const syl = await scanned(drops.intake({ name: 'chm110.txt', data: Buffer.from('CHM 110 syllabus').toString('base64'), section: 'grades' }).id);
      check('the scan keeps the grading breakdown', syl.status === 'ready' && syl.grading && syl.grading.categories.length === 3 && syl.grading.total === 100);
      check('a file dropped on Grades says so', syl.section === 'grades');
      const data = grades.load();
      const r = grades.applyGrading(data, syl.grading, { type: 'file', ref: syl.id });
      grades.save(data);
      drops.markGradingAdded(syl.id, r.course.id);
      check('adding it remembers which course it went to', drops.getDrop(syl.id).gradingAdded === r.course.id);

      claude.messages = reply({
        title: 'Canvas grades', folder: 'school', summary: 'Scores so far.', highlights: [], documentKind: 'grades', grading: null,
        items: [
          { ...blankItem, kind: 'grade', title: 'Lab 1', course: 'CHM 110', amount: 18, outOf: 20, category: 'Labs', date: '2026-09-10' },
          { ...blankItem, kind: 'grade', title: 'Quiz 1', course: 'CHM110', amount: 9, outOf: 10, category: null },
          { ...blankItem, kind: 'grade', title: 'Essay 1', course: 'ENG 101', amount: 88, outOf: 100, category: 'Essays' },
          { ...blankItem, kind: 'grade', title: 'Mystery', course: null, amount: 5, outOf: 10 },
        ],
      });
      const shot = await scanned(drops.intake({ name: 'grades.png.txt', data: Buffer.from('grades page').toString('base64'), section: 'grades' }).id);
      check('a grades page lists each score', shot.items.filter((x) => x.kind === 'grade').length === 4 && shot.grading === null);
      const res = drops.apply(shot.id, shot.items.map((x) => ({ id: x.id })));
      check('ticked scores are added', res.added.grades === 3);
      check('a score with no course is refused, with a reason', res.errors.some((e) => /Mystery: it has no course/.test(e)));
      const after = grades.load();
      const chm = grades.findCourse(after, 'CHM 110');
      check('each score lands in its category', chm.grades.find((g) => g.title === 'Lab 1').category === chm.categories.find((k) => k.name === 'Labs').id && chm.grades.find((g) => g.title === 'Quiz 1').category === chm.categories.find((k) => k.name === 'Quizzes').id);
      check('a course first seen on the page is added with its score', !!grades.findCourse(after, 'ENG 101') && drops.getDrop(shot.id).items.find((x) => x.title === 'Essay 1').addedAs === 'a grade in ENG 101 (new course)');
      const marked = drops.markExisting({ id: 'y', items: [{ id: 'a', kind: 'grade', title: 'Quiz 1', course: 'chm110', amount: 9, outOf: 10 }, { id: 'b', kind: 'grade', title: 'Quiz 2', course: 'CHM 110', amount: 9, outOf: 10 }] },
        { grades: [{ course: 'CHM 110', title: 'Quiz 1', score: 9, outOf: 10 }] });
      check('a score already in Grades is marked, and a new one is not', marked.items[0].existing === 'grades' && !marked.items[1].existing);
    }

    console.log('\nThe assistant logs a score');
    {
      const versions = require('./lib/versions');
      const realEnsure = versions.ensureOriginal;
      versions.ensureOriginal = () => null;
      const script = [
        { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'g1', name: 'log_grade', input: { course: 'chm 110', title: 'Exam 1', score: 41, out_of: 50, category: '' } }] },
        { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Logged it.' }] },
      ];
      const seen = [];
      claude.messages = async (body) => { seen.push(JSON.parse(JSON.stringify(body.messages))); return { ...script.shift(), usd: 0, usage: {} }; };
      check('get_grades and log_grade are offered', assistant.TOOLS.some((t) => t.name === 'get_grades') && assistant.TOOLS.some((t) => t.name === 'log_grade'));
      const ctx = { loopback: true, log: () => {}, state: () => ({}), calendar: async () => ({ days: [] }), news: async () => ({}) };
      let c = assistant.send({ text: 'I got a 41 out of 50 on the CHM exam', page: 'Grades' }, ctx);
      await assistant.settle(c.id);
      c = assistant.publicConv(assistant.loadConv(c.id));
      check('it waits for approval, showing the score and category', c.status === 'waiting' && /Log grade: CHM 110 Exam 1, 41\/50 \(82%\)/.test(c.pending[0].title) && /In Exams/.test(c.pending[0].detail));
      check('nothing is saved before approval', !grades.findCourse(grades.load(), 'CHM 110').grades.some((g) => g.title === 'Exam 1'));
      assistant.decide({ id: c.id, all: true }, ctx);
      await assistant.settle(c.id);
      const chm = grades.findCourse(grades.load(), 'CHM 110');
      const g = chm.grades.find((x) => x.title === 'Exam 1');
      check('approving saves it, from the assistant', !!g && g.source === 'assistant' && g.score === 41);
      check('Claude hears the new course grade', JSON.stringify(seen[1]).includes('CHM 110 is now'));

      const d = grades.load(); d.settings.shareWithAi = false; grades.save(d);
      check('private grades are hidden from get_grades', grades.forAi(grades.load()).private === true);
      versions.ensureOriginal = realEnsure;
      assistant.deleteConv(c.id);
    }
  } catch (e) {
    fail++;
    console.log(`  FAIL  threw: ${e.stack || e.message}`);
  } finally {
    claude.messages = realMessages;
    claude.unavailable = realUnavailable;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
