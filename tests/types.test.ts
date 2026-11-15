process.env.SOCRATES_EMBEDDINGS ??= 'off';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { App } from '../src/core/app.ts';
import { autoGrade, clozeParts, clozePublicPrompt } from '../src/core/qtypes.ts';
import { runJs } from '../src/core/coderun.ts';
import { saveImage, fetchImage, decodeBase64 } from '../src/core/media.ts';

test('matching, ordering and hotspot grading', () => {
  const m = { pairs: [{ left: 'H', right: 'Hydrogen' }, { left: 'He', right: 'Helium' }, { left: 'Li', right: 'Lithium' }], distractors: ['Lead'] };
  assert.equal(autoGrade('matching', m, { map: [0, 1, 2] })!.correct, true);
  const half = autoGrade('matching', m, { map: [0, 3, null] })!;
  assert.equal(half.score, 0.333);
  assert.equal(autoGrade('ordering', { items: ['a', 'b', 'c', 'd'] }, { order: [0, 1, 2, 3] })!.correct, true);
  const swapped = autoGrade('ordering', { items: ['a', 'b', 'c', 'd'] }, { order: [1, 0, 2, 3] })!;
  assert.equal(swapped.correct, false);
  assert.equal(swapped.score, 0.833, '5 of 6 pairs in order');
  assert.equal(autoGrade('ordering', { items: ['a', 'b', 'c'] }, { order: [0, 0, 1] })!.score, 0, 'invalid permutation scores 0');
  const spot = { image: '/media/x.png', regions: [{ x: 0.2, y: 0.2, w: 0.1, h: 0.1 }] };
  assert.equal(autoGrade('hotspot', spot, { x: 0.25, y: 0.25 })!.correct, true);
  assert.equal(autoGrade('hotspot', spot, { x: 0.5, y: 0.25 })!.correct, false);
});

test('cloze: answers never reach the public prompt and grade like blanks', () => {
  const p = 'Water is {{c1::H2O|h₂o::formula}} and boils at {{c2::100}} °C.';
  assert.deepEqual(clozeParts(p).map((x) => x.accept), [['H2O', 'h₂o'], ['100']]);
  const pub = clozePublicPrompt(p);
  assert.ok(!pub.includes('H2O') && !pub.includes('100'), pub);
  assert.equal((pub.match(/\{\{blank\}\}/g) ?? []).length, 2);
  assert.match(pub, /formula/);
  assert.equal(autoGrade('cloze', {}, { blanks: ['h2o', '100'] }, p)!.correct, true);

  const app = new App(':memory:');
  app.tags.create('Chem');
  const [r] = app.questions.add([{ type: 'cloze', prompt: p, tags: ['chem'] }]);
  assert.equal(r.status, 'created');
  const s = app.study.startSession({ mode: 'practice' });
  assert.ok(!JSON.stringify(s.questions).includes('H2O'), 'session payload hides cloze answers');
  const out = app.study.submit({ question_id: (r as any).id, response: { blanks: ['H2O', '99'] }, shown_at: Date.now(), time_ms: 4000 });
  assert.equal(out.score, 0.5);
  assert.deepEqual(app.questions.add([{ type: 'cloze', prompt: 'No cloze here', tags: ['chem'] }])[0].status, 'invalid');
});

test('code runner: pass, fail, errors, timeouts and no host access', async () => {
  const tests = [{ args: [2, 3], expected: 5 }, { args: [-1, 1], expected: 0 }, { args: [0.1, 0.2], expected: 0.3, hidden: true }];
  const ok = await runJs('function solution(a, b) { return a + b }', tests);
  assert.equal(ok.passed, 3);
  const wrong = await runJs('function solution(a, b) { return a - b }', tests);
  assert.equal(wrong.passed, 0);
  const missing = await runJs('const x = 1', tests);
  assert.match(missing.error!, /Define a function named solution/);
  const loop = await runJs('function solution() { while (true) {} }', tests.slice(0, 1));
  assert.equal(loop.passed, 0);
  assert.match(loop.results[0].error ?? loop.error ?? '', /timed out|Timed out/i);
  const escape = await runJs('function solution() { return typeof require + typeof process }', [{ args: [], expected: 'undefinedundefined' }]);
  assert.equal(escape.passed, 1, 'no require or process inside the sandbox');
  const objs = await runJs('function solution(xs) { return { sum: xs.reduce((a, b) => a + b, 0), n: xs.length } }', [{ args: [[1, 2, 3]], expected: { n: 3, sum: 6 } }]);
  assert.equal(objs.passed, 1, 'deep equality ignores key order');
  const inf = await runJs('function solution(xs) { return Math.max(...xs) }', [{ args: [[]], expected: null }]);
  assert.equal(inf.passed, 0, '-Infinity must not pass as null');
  assert.equal(inf.results[0].actual, '-Infinity');
  const und = await runJs('function solution() {}', [{ args: [], expected: null }]);
  assert.equal(und.passed, 0, 'undefined must not pass as null');
});

test('code runner: escaping the VM context still cannot touch the host', async () => {
  // The VM is not a boundary: this escape works. The child process's permission model is what holds.
  const host = "const p = console.log.constructor('return process')();";
  const probe = (expr: string) => runJs(`function solution() { ${host} try { return ${expr} } catch (e) { return e.code || e.message } }`, [{ args: [], expected: 'x' }]);
  const reached = await probe(`typeof p.pid`);
  assert.equal(reached.results[0].actual, '"number"', 'the escape does reach a real process object');
  const read = await probe(`p.getBuiltinModule('node:fs').readFileSync(${JSON.stringify(process.execPath)}).length`);
  assert.equal(read.results[0].actual, '"ERR_ACCESS_DENIED"');
  const write = await probe(`p.getBuiltinModule('node:fs').writeFileSync('socrates-pwned.txt', 'x')`);
  assert.equal(write.results[0].actual, '"ERR_ACCESS_DENIED"');
  const spawnIt = await probe(`p.getBuiltinModule('node:child_process').execSync('echo hi').toString()`);
  assert.equal(spawnIt.results[0].actual, '"ERR_ACCESS_DENIED"');
  const env = await probe(`Object.keys(p.env).filter((k) => /SOCRATES|TOKEN|SECRET|PASSWORD/i.test(k)).length`);
  assert.equal(env.results[0].actual, '0');
  const mem = await runJs('function solution() { const a = []; while (true) a.push(new Array(1e6).fill(1)); }', [{ args: [], expected: 1 }]);
  assert.equal(mem.passed, 0);
});

test('code questions: JS with tests is auto-graded, other languages wait for a grade', async () => {
  const app = new App(':memory:');
  app.tags.create('Prog');
  const res = app.questions.add([
    { type: 'code', prompt: 'Return the sum of an array.', language: 'javascript', tests: [{ args: [[1, 2]], expected: 3 }, { args: [[]], expected: 0, hidden: true }], tags: ['prog'] },
    { type: 'code', prompt: 'Write a Python function that reverses a string.', language: 'python', reference_solution: 'def solution(s): return s[::-1]', tags: ['prog'] },
    { type: 'code', prompt: 'Python with tests', language: 'python', tests: [{ args: [1], expected: 1 }], tags: ['prog'] },
  ]);
  assert.equal(res[2].status, 'invalid');
  const [js, py] = res.map((r: any) => r.id);
  const pub = app.questions.toPublic(app.questions.get(js)!);
  assert.deepEqual(pub.spec.tests[1], { hidden: true }, 'hidden test details are not public');
  const a = await app.study.submitAsync({ question_id: js, response: { code: 'const solution = (xs) => xs.reduce((a, b) => a + b, 0)' }, shown_at: Date.now(), time_ms: 30000 });
  assert.equal(a.correct, true);
  const b = await app.study.submitAsync({ question_id: py, response: { code: 'def solution(s): return s' }, shown_at: Date.now(), time_ms: 30000 });
  assert.equal(b.grade_status, 'pending');
  assert.equal(app.study.pendingGrades()[0].response, 'def solution(s): return s');
});

test('media: only raster images, stored by hash; private URLs refused', async () => {
  process.env.SOCRATES_MEDIA = mkdtempSync(join(tmpdir(), 'socrates-media-'));
  const png = decodeBase64('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==');
  const a = saveImage(png), b = saveImage(png);
  assert.equal(a.url, b.url);
  assert.match(a.url, /^\/media\/[a-f0-9]{32}\.png$/);
  assert.throws(() => saveImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), /Unsupported/);
  await assert.rejects(fetchImage('http://example.com/a.png'), /https/);
  await assert.rejects(fetchImage('https://127.0.0.1/a.png'), /private or local/);
  await assert.rejects(fetchImage('https://localhost/a.png'), /private or local/);
});

test('exam mode spreads questions across tags; time limits are kept', () => {
  const app = new App(':memory:');
  for (const t of ['A', 'B', 'C']) app.tags.create(t);
  const items = [];
  for (const t of ['a', 'b', 'c']) for (let i = 0; i < 8; i++) items.push({ type: 'true_false', prompt: `Topic ${t} statement number ${i} about ${t}${i}`, correct: true, tags: [t] });
  app.questions.add(items);
  const s = app.study.startSession({ mode: 'exam', limit: 9, time_limit_s: 600 });
  assert.equal(s.questions.length, 9);
  assert.equal(s.time_limit_s, 600);
  const per = new Map<string, number>();
  for (const q of s.questions) per.set(q.tags[0], (per.get(q.tags[0]) ?? 0) + 1);
  assert.deepEqual([...per.values()], [3, 3, 3]);
  assert.equal(app.study.loadSession(s.session_id).time_limit_s, 600);
});
