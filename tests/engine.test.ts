import { test } from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../src/core/app.ts';
import { embed } from '../src/core/embed.ts';

const mk = () => new App(':memory:');
const answer = (app: App, qid: number, response: unknown, extra: Record<string, unknown> = {}) =>
  app.study.submit({ question_id: qid, response, shown_at: Date.now() - 5000, time_ms: 5000, ...extra });

function bank(app: App) {
  app.tags.create('Math > Algebra');
  app.tags.create('Math > Geometry');
  const items = [];
  for (let i = 0; i < 6; i++) items.push({ type: 'true_false', prompt: `Algebra fact number ${i} about polynomials of degree ${i + 2}`, correct: true, tags: ['math > algebra'], difficulty: (i % 5) + 1 });
  for (let i = 0; i < 6; i++) items.push({ type: 'true_false', prompt: `Geometry fact number ${i} about polygons with ${i + 3} sides`, correct: true, tags: ['math > geometry'], difficulty: 3 });
  const res = app.questions.add(items);
  return res.map((r: any) => r.id as number);
}

test('calibration: abilities follow results and difficulty moves the other way', () => {
  const app = mk();
  const ids = bank(app);
  const [alg, geo] = [ids.slice(0, 6), ids.slice(6)];
  for (const id of alg) answer(app, id, { value: true });
  for (const id of geo) answer(app, id, { value: false });
  const m = new Map(app.stats.tagMastery().map((t) => [t.path, t]));
  assert.ok(m.get('math/algebra')!.mastery > 0.6, 'algebra mastery rose');
  assert.ok(m.get('math/geometry')!.mastery < 0.4, 'geometry mastery fell');
  // Parent gets half-weight updates from both.
  const parent = m.get('math')!;
  assert.ok(parent.mastery > m.get('math/geometry')!.mastery && parent.mastery < m.get('math/algebra')!.mastery);
  // Missed questions became harder, answered ones easier.
  const b = (id: number) => (app.db.prepare('SELECT irt_b FROM questions WHERE id = ?').get(id) as { irt_b: number }).irt_b;
  assert.ok(b(geo[0]) > 0, 'missed question calibrated harder than its seed');
  assert.ok(b(alg[2]) < 0, 'answered question calibrated easier than its seed');
  // Predictions follow.
  assert.ok(app.study.engine.predict(alg[0]) > app.study.engine.predict(geo[0]));
});

test('weak mode targets the weakest tag; adaptive respects daily new limit', () => {
  const app = mk();
  const ids = bank(app);
  for (const id of ids.slice(0, 4)) answer(app, id, { value: true });
  for (const id of ids.slice(6, 10)) answer(app, id, { value: false });
  // Recently answered questions are skipped, so make them old.
  app.db.prepare('UPDATE attempts SET answered_at = answered_at - 3600000').run();
  const weak = app.study.startSession({ mode: 'weak', limit: 5 });
  assert.ok(weak.questions.length > 0);
  assert.ok(weak.questions.every((q) => q.tags.includes('math/geometry')), JSON.stringify(weak.questions.map((q) => q.tags)));
  app.updateSettings({ new_per_day: 9 }); // 8 new already seen today -> 1 left
  const ad = app.study.startSession({ mode: 'adaptive', limit: 20 });
  const unseen = ad.questions.filter((q) => !app.db.prepare('SELECT 1 FROM srs_cards WHERE question_id = ?').get(q.id));
  assert.equal(unseen.length, 1);
});

test('undo restores schedule, calibration and removes the attempt', () => {
  const app = mk();
  const [id] = bank(app);
  const before = { b: app.db.prepare('SELECT irt_b, irt_n FROM questions WHERE id = ?').get(id), ab: app.db.prepare('SELECT COUNT(*) n FROM ability').get() };
  const r = answer(app, id, { value: false });
  assert.ok(app.db.prepare('SELECT 1 FROM srs_cards WHERE question_id = ?').get(id));
  app.study.undo(r.attempt_id);
  assert.equal(app.db.prepare('SELECT 1 FROM srs_cards WHERE question_id = ?').get(id), undefined);
  assert.deepEqual(app.db.prepare('SELECT irt_b, irt_n FROM questions WHERE id = ?').get(id), before.b);
  assert.deepEqual(app.db.prepare('SELECT COUNT(*) n FROM ability').get(), before.ab);
  assert.equal((app.db.prepare('SELECT COUNT(*) n FROM attempts').get() as { n: number }).n, 0);
  // Only the latest attempt can be undone.
  const a1 = answer(app, id, { value: true });
  answer(app, id, { value: true });
  assert.throws(() => app.study.undo(a1.attempt_id), /most recent/);
});

test('leeches are flagged after repeated lapses and leave the queue', () => {
  const app = mk();
  const [id] = bank(app);
  app.updateSettings({ leech_threshold: 3 });
  let leech = false;
  // Fast, confident correct answers graduate the card (Easy); each wrong answer after that is a lapse.
  for (let i = 0; i < 12 && !leech; i++)
    leech = (i % 2 === 0 ? answer(app, id, { value: true }, { time_ms: 800, confidence: 4 }) : answer(app, id, { value: false })).leech;
  assert.ok(leech, 'became a leech');
  assert.match(app.questions.get(id)!.flagged_reason!, /^Leech/);
  assert.ok(!app.study.startSession({ mode: 'practice', limit: 50 }).questions.some((q) => q.id === id));
});

test('recommendations and analytics shapes', () => {
  const app = mk();
  const ids = bank(app);
  for (const id of ids.slice(6)) answer(app, id, { value: false }, { confidence: 4 });
  const recs = app.stats.recommendations();
  assert.ok(recs.some((r) => r.kind === 'weak' && r.title.includes('Geometry')), JSON.stringify(recs));
  assert.ok(recs.some((r) => r.kind === 'overconfident' || r.kind === 'weak'));
  assert.ok(recs.some((r) => r.kind === 'agent'), 'thin weak tag suggests asking the agent');
  const a = app.stats.analytics();
  assert.equal(a.totals.attempts, 6);
  assert.equal(a.confidence[0].k, 4);
  assert.ok(a.mastery.length >= 2);
});

test('meaning-based duplicates are flagged (not rejected) only when answers agree', async (t) => {
  if (!(await embed(['probe']))) return t.skip('embedding model unavailable (offline)');
  const app = mk();
  app.tags.create('Math > Linear Algebra');
  app.tags.create('Bio');
  const tag = ['math > linear algebra'];
  const [first] = await app.questions.addAsync([{ type: 'true_false', prompt: 'Every square matrix is invertible.', correct: false, tags: tag }]);
  assert.equal(first.status, 'created');
  const r = await app.questions.addAsync([
    { type: 'true_false', prompt: 'Every square matrix has an inverse.', correct: false, tags: tag }, // paraphrase, same answer
    { type: 'true_false', prompt: 'Every invertible matrix is square.', correct: true, tags: tag }, // converse, different answer
    { type: 'mcq_single', prompt: 'Which organelle produces most of the cell\'s ATP?', options: ['Mitochondria', 'Ribosome', 'Nucleus'], correct: 0, tags: ['bio'] },
  ]);
  assert.equal(r[0].status, 'created');
  assert.ok((r[0] as any).near_duplicates?.some((h: any) => h.match === 'meaning'), 'paraphrase flagged');
  assert.equal(r[1].status, 'created');
  assert.ok(!(r[1] as any).near_duplicates, 'converse with a different answer is not flagged');
  assert.ok(!(r[2] as any).near_duplicates);
});
