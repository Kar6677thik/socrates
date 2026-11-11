process.env.SOCRATES_EMBEDDINGS ??= 'off'; // wording-only here; meaning checks are in engine.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../src/core/app.ts';
import { slugify, splitPath } from '../src/core/text.ts';
import { autoGrade } from '../src/core/qtypes.ts';
import { deriveRating, retrievability, Rating, studyDay } from '../src/core/srs.ts';

const mk = () => new App(':memory:');

test('slugify normalizes case, plurals, diacritics and symbols', () => {
  assert.equal(slugify('Integrals '), 'integral');
  assert.equal(slugify('INTEGRAL'), 'integral');
  assert.equal(slugify('Physics'), 'physics');
  assert.equal(slugify('Data & Algorithms'), 'data-and-algorithm');
  assert.equal(slugify('Café Théories'), 'cafe-theory');
  assert.equal(slugify('C++'), 'cpp');
  assert.equal(slugify('C#'), 'csharp');
  assert.equal(slugify('Matrices'), 'matrix');
  assert.equal(slugify('Statistics'), 'statistics');
  assert.deepEqual(splitPath('Math > Calculus > Integrals'), ['Math', 'Calculus', 'Integrals']);
  assert.deepEqual(splitPath('math/calculus'), ['math', 'calculus']);
});

test('tag resolution reuses exact, normalized and aliased tags', () => {
  const app = mk();
  const { tag } = app.tags.create('Math > Calculus > Integrals');
  assert.equal(tag.path, 'math/calculus/integral');
  assert.equal(app.tags.resolve('math > calculus > INTEGRAL').tag_id, tag.id);
  assert.equal(app.tags.resolve('Mathematics').tag_id, null);
  app.tags.addAlias(app.tags.byPath('math')!.id, 'Mathematics');
  const r = app.tags.resolve('Mathematics > Calculus > integrals');
  assert.equal(r.tag_id, tag.id);
  assert.equal(r.how, 'alias');
  // Creating an existing path is a no-op reuse.
  assert.equal(app.tags.create('math > calculus > integrals').reused, true);
});

test('create refuses near-duplicate tags unless forced with justification', () => {
  const app = mk();
  app.tags.create('Programming > JavaScript');
  assert.throws(() => app.tags.create('Programming > Javascrpt'), /looks like an existing tag/);
  assert.throws(() => app.tags.create('Programming > Javascrpt', { force: true }), /justification/);
  app.tags.create('Machine Learning');
  const ml = app.tags.resolve('ML');
  assert.ok(ml.suggestions.some((s) => s.path === 'machine-learning'), 'acronym suggests machine-learning');
  app.tags.create('Linear Algebra');
  assert.ok(app.tags.resolve('Algebra Linear').suggestions.some((s) => s.path === 'linear-algebra'));
  // Same leaf under a different parent is surfaced.
  const r = app.tags.resolve('Calc > Integrals');
  app.tags.create('Math > Integrals');
  const r2 = app.tags.resolve('Calculus > Integrals');
  assert.ok(r2.suggestions.some((s) => s.path === 'math/integral'));
  assert.equal(r.tag_id, null);
  // Genuinely different tags are allowed.
  app.tags.create('Programming > Java');
  assert.ok(app.tags.byPath('programming/java'));
});

test('merge moves questions and children and keeps the old name resolving', () => {
  const app = mk();
  app.tags.create('Math > Integration > Substitution');
  app.tags.create('Math > Integrals', { force: true, justification: 'test' });
  const [res] = app.questions.add([{ type: 'true_false', prompt: 'u-substitution reverses the chain rule', correct: true, tags: ['math > integration'] }]);
  assert.equal(res.status, 'created');
  const src = app.tags.byPath('math/integration')!, dst = app.tags.byPath('math/integral')!;
  app.tags.merge(src.id, dst.id);
  assert.equal(app.tags.resolve('Math > Integration').tag_id, dst.id);
  assert.equal(app.tags.resolve('Math > Integration > Substitution').path, 'math/integral/substitution');
  assert.equal(app.questions.get((res as any).id)!.tags[0].path, 'math/integral');
});

test('add_questions: validation, strict tags, idempotency, dedup', () => {
  const app = mk();
  app.tags.create('Bio > Cells');
  const base = { type: 'mcq_single', prompt: 'What is the powerhouse of the cell?', options: ['Nucleus', 'Mitochondria', 'Ribosome'], correct: 1, tags: ['bio > cells'] };
  const r = app.questions.add([
    base,
    { ...base, prompt: 'What is the powerhouse of the cell?' }, // same as item 0
    { type: 'mcq_single', prompt: 'x', options: ['a'], correct: 0, tags: ['bio'] }, // invalid
    { type: 'true_false', prompt: 'Cells have walls', correct: false, tags: ['Biology > Cell Walls'] }, // unresolved
    { type: 'fill_blank', prompt: 'DNA is copied in {{blank}} phase', blanks: [{ accept: ['S'] }, { accept: ['x'] }], tags: ['bio'] },
    { ...base, prompt: 'Which organelle produces ATP?', client_ref: 'k1' },
  ]);
  assert.equal(r[0].status, 'created');
  assert.equal(r[1].status, 'duplicate');
  assert.equal(r[2].status, 'invalid');
  assert.equal(r[3].status, 'unresolved_tags');
  assert.equal(r[4].status, 'invalid');
  assert.match((r[4] as any).errors[0], /1 \{\{blank\}\} markers but 2/);
  assert.equal(r[5].status, 'created');
  // Retry with the same client_ref returns the existing question.
  const again = app.questions.add([{ ...base, prompt: 'Something else entirely', client_ref: 'k1' }]);
  assert.equal(again[0].status, 'exists');
  // Rewording is caught by similarity.
  const near = app.questions.add([{ ...base, prompt: 'What is the powerhouse of a cell?' }]);
  assert.equal(near[0].status, 'duplicate');
  // Different question in the same topic is fine.
  const other = app.questions.add([{ type: 'true_false', prompt: 'Ribosomes synthesize proteins', correct: true, tags: ['bio/cells'] }]);
  assert.equal(other[0].status, 'created');
});

test('agent-added questions start as drafts', () => {
  const app = mk();
  app.tags.create('Chem');
  const [r] = app.questions.add([{ type: 'true_false', prompt: 'Water is polar', correct: true, tags: ['chem'] }], { actor: 'agent:claude' });
  assert.equal((r as any).question_status, 'draft');
});

test('graders', () => {
  assert.deepEqual(autoGrade('mcq_single', { options: ['a', 'b'], correct: 1 }, { choice: 1 })!.correct, true);
  const multi = autoGrade('mcq_multi', { options: ['a', 'b', 'c', 'd'], correct: [0, 2] }, { choices: [0, 1] })!;
  assert.equal(multi.score, 0);
  assert.equal(autoGrade('mcq_multi', { options: ['a', 'b', 'c'], correct: [0, 2] }, { choices: [0] })!.score, 0.5);
  const fb = autoGrade('fill_blank', { blanks: [{ accept: ['Paris'] }, { accept: ['0.5'] }] }, { blanks: [' paris ', '1/2'] })!;
  assert.equal(fb.correct, true);
  assert.equal(autoGrade('numeric', { answer: 9.81, tolerance: 0.01, relative: true }, { value: '9.8' })!.correct, true);
  assert.equal(autoGrade('numeric', { answer: 9.81, tolerance: 0.001 }, { value: '9.8' })!.correct, false);
  assert.equal(autoGrade('numeric', { answer: 1500 }, { value: '1,500' })!.correct, true);
  assert.equal(autoGrade('numeric', { answer: 0.25 }, { value: '25%' })!.correct, true);
});

test('rating derivation and forgetting curve', () => {
  const b = 10000;
  assert.equal(deriveRating({ score: 0, time_ms: 5000, baseline_ms: b }), Rating.Again);
  assert.equal(deriveRating({ score: 0.6, time_ms: 5000, baseline_ms: b }), Rating.Hard);
  assert.equal(deriveRating({ score: 1, time_ms: 9000, baseline_ms: b, hints_used: 1 }), Rating.Hard);
  assert.equal(deriveRating({ score: 1, time_ms: 3000, baseline_ms: b, confidence: 4 }), Rating.Easy);
  assert.equal(deriveRating({ score: 1, time_ms: 9000, baseline_ms: b, confidence: 3 }), Rating.Good);
  assert.ok(Math.abs(retrievability(10, 10) - 0.9) < 1e-9, 'R = 0.9 when t = S');
  assert.ok(retrievability(10, 30) < retrievability(10, 10));
  // Day rolls over at 4am local.
  const d = new Date(2026, 0, 2, 3, 0).getTime();
  assert.equal(studyDay(d), '2026-01-01');
});

test('study flow: srs queue, attempts, pending grades, versions', () => {
  const app = mk();
  app.tags.create('Geo');
  const res = app.questions.add([
    { type: 'mcq_single', prompt: 'Capital of France?', options: ['Paris', 'Rome'], correct: 0, tags: ['geo'], group_id: 'g' },
    { type: 'true_false', prompt: 'The Nile is in Africa', correct: true, tags: ['geo'], group_id: 'g' },
    { type: 'short_answer', prompt: 'Explain plate tectonics', model_answer: 'Lithosphere plates move over the mantle', tags: ['geo'], rubric: [{ criterion: 'mentions plates', points: 1 }] },
    { type: 'flashcard', prompt: 'Largest ocean', back: 'Pacific', tags: ['geo'] },
  ]);
  assert.ok(res.every((r) => r.status === 'created'), JSON.stringify(res));
  const s = app.study.startSession({ mode: 'srs' });
  assert.equal(s.questions.length, 4);
  assert.equal((s.questions.find((q) => q.type === 'mcq_single')!.spec as any).correct, undefined, 'answer is hidden');
  const mcq = s.questions.find((q) => q.type === 'mcq_single')!;
  const out = app.study.submit({ session_id: s.session_id, question_id: mcq.id, response: { choice: 0 }, shown_at: Date.now() - 4000, time_ms: 4000, confidence: 4 });
  assert.equal(out.correct, true);
  assert.ok(out.next_due! > Date.now());
  const sa = s.questions.find((q) => q.type === 'short_answer')!;
  const p = app.study.submit({ session_id: s.session_id, question_id: sa.id, response: { text: 'plates move' }, shown_at: Date.now(), time_ms: 30000 });
  assert.equal(p.grade_status, 'pending');
  assert.equal(app.study.pendingGrades().length, 1);
  const g = app.study.grade(p.attempt_id, { score: 0.9, feedback: 'Good', grader: 'agent:test' });
  assert.equal(g.schedule_updated, true);
  assert.equal(app.study.pendingGrades().length, 0);
  // A second srs session now excludes reviewed questions that are not due.
  const s2 = app.study.startSession({ mode: 'srs' });
  assert.ok(!s2.questions.some((q) => q.id === mcq.id));
  // Major edit resets schedule; minor keeps it.
  const minor = app.questions.update(mcq.id, { explanation: 'Paris is the capital.' });
  assert.equal(minor.edit_kind, 'minor');
  const major = app.questions.update(mcq.id, { correct: 1 });
  assert.equal(major.edit_kind, 'major');
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM srs_cards WHERE question_id = ?').get(mcq.id)!.n, 0);
  app.questions.restore(mcq.id, 2);
  assert.equal(app.questions.get(mcq.id)!.spec.correct, 0);
  // Stats
  const home = app.stats.home();
  assert.equal(home.streak.current, 1);
  assert.equal(app.stats.recentMistakes().length, 0);
});
