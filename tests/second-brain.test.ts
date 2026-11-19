// Cross-app features: question sources, openable links, study tasks for Hey Ann, and server-side study rewards.
process.env.SOCRATES_EMBEDDINGS ??= 'off';
process.env.SOCRATES_URL = 'https://socrates.example.ts.net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { App } from '../src/core/app.ts';
import { buildMcpServer } from '../src/mcp/server.ts';
import { RULES } from '../src/core/rewards.ts';
import { studyDay } from '../src/core/srs.ts';
import { exportJson } from '../src/core/importer.ts';

const ORIGIN = 'https://socrates.example.ts.net';
const SLATE = { app: 'slate', id: 'note:1f0c3a52-6d1e-4c1b-9f5e-0a2b3c4d5e6f', url: 'https://lib.example.com/?note=1f0c3a52-6d1e-4c1b-9f5e-0a2b3c4d5e6f', title: 'Raft consensus' };

async function mcp(app: App, scopes?: string[]) {
  const server = buildMcpServer(app, scopes ? { scopes: new Set(scopes) } : {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test-agent', version: '1' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { error: !!r.isError, data: JSON.parse(r.content[0].text) };
  };
  return { client, call };
}

test('source: structured link stored and returned; text is a citation; unsafe URLs refused', () => {
  const app = new App(':memory:');
  app.tags.create('cs > distributed');
  const [a, b, bad] = app.questions.add([
    { type: 'flashcard', prompt: 'What does a Raft leader send to keep followers in line?', back: 'Heartbeats (empty AppendEntries)', tags: ['cs > distributed'], source: SLATE },
    { type: 'flashcard', prompt: 'Who proposed Paxos?', back: 'Leslie Lamport', tags: ['cs > distributed'], source: 'Lamport 1998, ch. 2', explanation: null },
    { type: 'flashcard', prompt: 'Bad link question', back: 'x', tags: ['cs > distributed'], source: { app: 'slate', id: 'note:x', url: 'javascript:alert(1)' } },
  ]) as any[];
  assert.equal(a.status, 'created');
  assert.equal(b.status, 'created', 'null explanation means "not given"');
  assert.equal(bad.status, 'invalid');
  const qa = app.questions.get(a.id)!;
  assert.deepEqual(qa.source, SLATE);
  assert.equal(qa.citation, null);
  const qb = app.questions.get(b.id)!;
  assert.equal(qb.source, null);
  assert.equal(qb.citation, 'Lamport 1998, ch. 2');
  // Edits keep the link unless it's removed; restore brings it back.
  app.questions.update(a.id, { explanation: 'Leaders send heartbeats every election-timeout fraction.' });
  assert.deepEqual(app.questions.get(a.id)!.source, SLATE);
  app.questions.update(a.id, { source: null });
  assert.equal(app.questions.get(a.id)!.source, null);
  app.questions.restore(a.id, 1);
  assert.deepEqual(app.questions.get(a.id)!.source, SLATE);
  // Export keeps both, and they import back.
  const exp = exportJson(app.db);
  const ea = exp.questions.find((q: any) => q.id === a.id) as any;
  const eb = exp.questions.find((q: any) => q.id === b.id) as any;
  assert.deepEqual(ea.source, SLATE);
  assert.equal(eb.citation, 'Lamport 1998, ch. 2');
  // The answer result carries the source for the quiz runner.
  const r: any = app.study.submit({ question_id: a.id, response: { rating: 3 }, shown_at: Date.now() - 4000, time_ms: 4000 });
  assert.deepEqual(r.source, SLATE);
});

test('MCP: openable links on questions, sessions, tags and references', async () => {
  const app = new App(':memory:');
  app.tags.create('math > calculus');
  const { call } = await mcp(app);
  const add = await call('add_questions', { items: [{ type: 'true_false', prompt: 'The derivative of a constant is zero', correct: true, tags: ['math > calculus'], source: SLATE }] });
  const created = add.data.results[0];
  assert.equal(created.url, `${ORIGIN}/library/${created.id}`);
  const dup = await call('add_questions', { items: [{ type: 'true_false', prompt: 'The derivative of a constant is zero', correct: true, tags: ['math > calculus'] }] });
  assert.equal(dup.data.results[0].duplicate_of[0].url, `${ORIGIN}/library/${created.id}`);
  const got = await call('get_questions', { ids: [created.id] });
  assert.equal(got.data.items[0].url, `${ORIGIN}/library/${created.id}`);
  assert.deepEqual(got.data.items[0].source, SLATE);
  const search = await call('search_questions', { query: 'derivative' });
  assert.equal(search.data.items[0].url, `${ORIGIN}/library/${created.id}`);
  const quiz = await call('create_quiz', { mode: 'practice' });
  assert.equal(quiz.data.url, `${ORIGIN}/study/${quiz.data.session_id}`);
  app.study.submit({ question_id: created.id, response: { value: false }, shown_at: Date.now() - 3000, time_ms: 3000 });
  const mistakes = await call('get_recent_mistakes');
  assert.equal(mistakes.data.mistakes[0].question_url, `${ORIGIN}/library/${created.id}`);
  const upd = await call('update_question', { id: created.id, changes: { explanation: 'd/dx c = 0' } });
  assert.equal(upd.data.url, `${ORIGIN}/library/${created.id}`);
});

test('study tasks: agreed shape, stable source ids, one-tap start links that work', async () => {
  const app = new App(':memory:');
  app.tags.create('math > calculus > integrals');
  app.tags.create('math > algebra');
  const items = [];
  for (let i = 0; i < 8; i++) items.push({ type: 'true_false', prompt: `Integral fact ${i}: the antiderivative of x^${i + 2} is known`, correct: true, tags: ['math > calculus > integrals'] });
  const ids = (app.questions.add(items) as any[]).map((r) => r.id);
  for (const id of ids) app.study.submit({ question_id: id, response: { value: false }, shown_at: Date.now() - 20_000, time_ms: 20_000 });
  app.db.prepare('UPDATE attempts SET answered_at = answered_at - 3600000').run(); // not "just seen" for the session queue
  const tasks = app.stats.studyTasks(5);
  const integrals = app.tags.resolve('math > calculus > integrals').tag_id!;
  const weak = tasks.find((t) => t.kind === 'weak')!;
  assert.ok(weak, 'a weak-area task');
  assert.equal(weak.title, 'Study: integrals');
  assert.match(weak.reason, /^Mastery \d+%.*8 mistakes this week\.$/);
  assert.deepEqual(weak.source, { app: 'socrates', id: `tag:${integrals}`, url: `${ORIGIN}/library?tag=${integrals}`, title: 'Weak area: integrals' });
  assert.equal(weak.session_url, `${ORIGIN}/study/start?mode=weak&tag=${integrals}&limit=15`);
  assert.ok(weak.estimate_min >= 5 && weak.estimate_min <= 45 && weak.estimate_min % 5 === 0);
  assert.deepEqual(tasks.map((t) => t.priority), tasks.map((_, i) => i + 1));
  assert.ok(!JSON.stringify(tasks.map((t) => t.source.id)).match(/\d{4}-\d{2}|%/), 'ids carry no day or mastery figure');
  // The link's parameters start a real session on those tags, including after a merge.
  const s = app.study.startSession({ mode: 'weak', tag_ids: [integrals], limit: 15 });
  assert.ok(s.questions.length > 0);
  app.tags.create('math > calculus > riemann sums');
  const target = app.tags.resolve('math > calculus > riemann sums').tag_id!;
  app.tags.merge(integrals, target);
  assert.ok(app.study.startSession({ mode: 'weak', tag_ids: [integrals] }).questions.length > 0, 'merged tag id still works');
  // Read-only tokens can plan.
  const { call } = await mcp(app, ['socrates.read']);
  const r = await call('get_study_tasks', { limit: 3 });
  assert.equal(r.error, false);
  assert.ok(r.data.tasks.length >= 1);
});

test('MCP: generate_from_source prompt and the planning/linking instructions', async () => {
  const app = new App(':memory:');
  const { client } = await mcp(app);
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
  assert.ok(prompts.includes('generate_from_source'));
  const p = await client.getPrompt({ name: 'generate_from_source', arguments: { source: SLATE.id } });
  const text = (p.messages[0].content as any).text as string;
  // Tool names in backticks, cross-app ones as `app.tool`: Orbit Hub rewrites exactly these to its own names.
  for (const step of ['`slate.read_note`', '`check_duplicates`', '`resolve_tags`', '`add_questions`', '`create_tags`', 'source', 'client_ref']) assert.ok(text.includes(step), step);
  assert.ok(!text.includes('get_tag_tree'), 'uses only tools in the Hub core');
  const ins = client.getInstructions() ?? '';
  assert.match(ins, /When Hey Ann tools are present, offer to schedule them with `heyann\.add_cards`/);
  // Every tool name in the instructions is backticked, so the Hub can rewrite it.
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of tools) assert.ok(!new RegExp('(^|[^\\w`])' + t + '(?![\\w`])').test(ins), `bare tool name in instructions: ${t}`);
  assert.match(ins, /never build or edit them/);
});

// ---------------------------------------------------------------- rewards

const MIN = 60_000, HOUR = 3600_000, DAY = 864e5;
// Reward tests run on a pinned clock: 10:00 local on a fixed date, so every scenario sits well inside one study day
// (which rolls over at 04:00 local) whatever the time of the run and whatever TZ the process has.
const BASE = new Date(2026, 9, 15, 10, 0, 0).getTime();

/** A bank of old questions plus raw attempt inserts with exact server timestamps. */
function rewardsFixture() {
  const app = new App(':memory:');
  app.tags.create('bio > cells');
  const items = [];
  for (let i = 0; i < 14; i++) items.push({ type: 'true_false', prompt: `Cell fact ${i}: organelle ${i} has a membrane of type ${i}`, correct: true, tags: ['bio > cells'] });
  items.push({ type: 'short_answer', prompt: 'Explain why mitochondria have their own DNA', model_answer: 'Endosymbiosis', tags: ['bio > cells'] });
  items.push({ type: 'flashcard', prompt: 'What is the powerhouse of the cell?', back: 'Mitochondria', tags: ['bio > cells'] });
  const ids = (app.questions.add(items) as any[]).map((r) => r.id);
  const t0 = BASE;
  app.db.prepare('UPDATE questions SET created_at = ?').run(t0 - 30 * DAY); // old questions
  app.rewards.tick(t0); // switch rewards on: sessions before now never pay
  const session = (startedAt: number, endedAt: number | null = null) =>
    Number(app.db.prepare(`INSERT INTO sessions(mode, config, queue, started_at, ended_at) VALUES('practice','{}','[]',?,?)`).run(startedAt, endedAt).lastInsertRowid);
  const attempt = (sid: number, qid: number, answeredAt: number, o: { score?: number | null; grade?: string; timeMs?: number; srsBefore?: string | null } = {}) => {
    const score = o.score === undefined ? 1 : o.score;
    return Number(app.db
      .prepare(
        `INSERT INTO attempts(question_id, question_version, session_id, response, is_correct, score, grade_status, hints_used, time_ms,
           answer_changes, shown_at, answered_at, local_hour, weekday, study_day, srs_before)
         VALUES(?,1,?,'{}',?,?,?,0,?,0,?,?,0,0,?,?)`,
      )
      .run(qid, sid, score == null ? null : score >= 0.8 ? 1 : 0, score, o.grade ?? 'auto', o.timeMs ?? 10 * MIN, answeredAt - 1000, answeredAt, studyDay(answeredAt), o.srsBefore === undefined ? null : o.srsBefore)
      .lastInsertRowid);
  };
  const events = () => app.rewards.list({ limit: 200 });
  return { app, ids, t0, session, attempt, events };
}

test('rewards: server gaps, caps, idle, browser time can only lower, closed sessions only', () => {
  const { app, ids, t0, session, attempt, events } = rewardsFixture();
  const s0 = t0 + HOUR;
  const sid = session(s0);
  attempt(sid, ids[0], s0 + 1 * MIN);                     // 1 min gap
  attempt(sid, ids[1], s0 + 6 * MIN);                     // 5 min gap -> capped at 3
  attempt(sid, ids[2], s0 + 26 * MIN);                    // 20 min gap -> idle, 0
  attempt(sid, ids[3], s0 + 28 * MIN, { timeMs: 30_000 }); // 2 min gap, browser says 30 s -> 0.5
  attempt(sid, ids[13], s0 + 33 * MIN, { grade: 'self' });  // flashcard-style self grade, 5 min gap -> 3 * 0.5
  assert.equal(app.rewards.tick(s0 + 40 * MIN).study, 0, 'still open: last answer under 30 min ago');
  assert.equal(app.rewards.tick(s0 + 64 * MIN).study, 1);
  const [e] = events();
  assert.equal(e.event_id, `socrates:study:${sid}`);
  assert.equal(e.minutes, 1 + 3 + 0.5 + 1.5);
  assert.equal(e.attempts_credited, 4);
  assert.equal(e.day, studyDay(s0 + 33 * MIN));
  assert.ok(e.intervals.every(([a, b]: number[]) => b > a));
  assert.equal(app.rewards.tick(s0 + 2 * HOUR).study, 0, 'idempotent');
});

test('rewards: no credit for known items, fresh questions, sessions before switch-on; due/new/recently-wrong count', () => {
  const { app, ids, t0, session, attempt, events } = rewardsFixture();
  // A session before rewards were switched on never pays.
  const old = session(t0 - HOUR, t0 - HOUR + 10 * MIN);
  attempt(old, ids[0], t0 - HOUR + 2 * MIN);
  const s0 = t0 + HOUR;
  const sid = session(s0, s0 + 20 * MIN);
  const notDue = JSON.stringify({ due: new Date(s0 + 5 * DAY).toISOString() });
  const due = JSON.stringify({ due: new Date(s0 - DAY).toISOString() });
  attempt(sid, ids[4], s0 + 2 * MIN, { srsBefore: notDue });      // seen, not due, not wrong -> 0
  attempt(sid, ids[5], s0 + 4 * MIN, { srsBefore: due });         // due review -> 2
  attempt(sid, ids[6], s0 + 6 * MIN);                             // never seen -> 2
  attempt(sid, ids[6], s0 + 8 * MIN);                             // answered correctly 2 min ago -> 0
  attempt(sid, ids[7], s0 + 9 * MIN, { score: 0, srsBefore: notDue }); // wrong but never wrong before -> 0
  attempt(sid, ids[7], s0 + 11 * MIN, { srsBefore: notDue });     // wrong 2 min ago -> 2
  app.db.prepare('UPDATE questions SET created_at = ? WHERE id = ?').run(s0, ids[8]);
  attempt(sid, ids[8], s0 + 13 * MIN);                            // question made 13 min ago -> 0
  app.rewards.tick(s0 + 21 * MIN);
  const evs = events().filter((e) => e.kind === 'study_minutes');
  assert.deepEqual(evs.map((e) => e.event_id), [`socrates:study:${sid}`]);
  assert.equal(evs[0].minutes, 6);
  assert.equal(evs[0].attempts_credited, 3);
});

test('rewards: written answers wait for grading; agent grades pay full, own grades half, late supplement once', () => {
  const { app, ids, t0, session, attempt, events } = rewardsFixture();
  const s0 = t0 + HOUR;
  const sid = session(s0, s0 + 10 * MIN);
  attempt(sid, ids[0], s0 + 2 * MIN);
  const essay = attempt(sid, ids[14], s0 + 7 * MIN, { score: null, grade: 'pending' }); // 5 min, long cap 6
  assert.equal(app.rewards.tick(s0 + 11 * MIN).study, 0, 'waits while a written answer is ungraded');
  assert.equal(app.rewards.tick(s0 + 10 * MIN + RULES.graceMs + MIN).study, 1, 'emits without it after the grace period');
  let [e] = events();
  assert.equal(e.minutes, 2);
  assert.equal(e.pending, 1);
  app.study.grade(essay, { score: 1, grader: 'agent:claude-ai' });
  assert.equal(app.rewards.tick(s0 + 3 * DAY).study, 1);
  [e] = events();
  assert.equal(e.event_id, `socrates:study:${sid}:late`);
  assert.equal(e.minutes, 5);
  assert.equal(e.supplement, true);
  assert.equal(app.rewards.tick(s0 + 4 * DAY).study, 0, 'one supplement only');
  // Own grade: half.
  const s1 = t0 + 2 * DAY; // past the 24 h "known" window for that question
  const sid2 = session(s1, s1 + 10 * MIN);
  const own = attempt(sid2, ids[14], s1 + 4 * MIN, { score: null, grade: 'pending' });
  app.study.grade(own, { score: 0.5, grader: 'self' });
  app.rewards.tick(s1 + 11 * MIN);
  assert.equal(events().find((x) => x.event_id === `socrates:study:${sid2}`)!.minutes, 2);
});

test('rewards: daily sanity cap and undo', () => {
  const { app, t0, session, attempt, events } = rewardsFixture();
  app.tags.create('bio > more');
  const extra = (app.questions.add(Array.from({ length: 70 }, (_, i) => ({ type: 'true_false', prompt: `Extra biology statement number ${i} concerning enzyme ${i * 7}`, correct: true, tags: ['bio > more'] }))) as any[]).map((r) => r.id);
  app.db.prepare('UPDATE questions SET created_at = ?').run(t0 - 30 * DAY);
  const ids = extra;
  let at = t0 + HOUR;
  // 70 sessions of 3 credited minutes = 210 > 180 cap, all on one study day.
  for (let i = 0; i < 70; i++) {
    const sid = session(at, at + 4 * MIN);
    attempt(sid, ids[i], at + 3 * MIN, { srsBefore: JSON.stringify({ due: new Date(at - DAY).toISOString() }) });
    at += 4 * MIN;
  }
  app.rewards.tick(at + HOUR);
  const total = events().filter((e) => e.kind === 'study_minutes').reduce((s, e) => s + e.minutes, 0);
  assert.ok(total <= RULES.dayMaxMinutes && total >= RULES.dayMaxMinutes - 3, `capped at ${RULES.dayMaxMinutes}, got ${total}`);
  // An undone attempt is deleted, so it can't count.
  const s2 = session(at + 2 * DAY, at + 2 * DAY + 5 * MIN);
  const id = attempt(s2, ids[0], at + 2 * DAY + 2 * MIN);
  app.db.prepare('DELETE FROM attempts WHERE id = ?').run(id);
  assert.equal(app.rewards.tick(at + 3 * DAY).study, 0);
});

test('rewards: the daily cap is per study day, and the day rolls over at 04:00 local', () => {
  const { app, t0, session, attempt, events } = rewardsFixture();
  app.tags.create('bio > boundary');
  const ids = (app.questions.add(Array.from({ length: 80 }, (_, i) => ({ type: 'true_false', prompt: `Boundary biology statement ${i} about protein ${i * 11}`, correct: true, tags: ['bio > boundary'] }))) as any[]).map((r) => r.id);
  app.db.prepare('UPDATE questions SET created_at = ?').run(t0 - 30 * DAY);
  // 40 sessions of 3 credited minutes ending before 04:00 local, then 40 after: 120 + 120 minutes over two study days.
  const rollover = new Date(2026, 9, 16, 4, 0, 0).getTime();
  const due = (at: number) => JSON.stringify({ due: new Date(at - DAY).toISOString() });
  let at = rollover - 40 * 4 * MIN - MIN;
  for (let i = 0; i < 80; i++) {
    if (i === 40) at = rollover + MIN;
    const sid = session(at, at + 4 * MIN);
    attempt(sid, ids[i], at + 3 * MIN, { srsBefore: due(at) });
    at += 4 * MIN;
  }
  app.rewards.tick(at + HOUR);
  const byDay = new Map<string, number>();
  for (const e of events().filter((e) => e.kind === 'study_minutes')) byDay.set(e.day, (byDay.get(e.day) ?? 0) + e.minutes);
  assert.deepEqual([...byDay.keys()].sort(), [studyDay(rollover - MIN), studyDay(rollover + MIN)]);
  assert.notEqual(studyDay(rollover - MIN), studyDay(rollover + MIN), '04:00 local starts a new study day');
  for (const [day, total] of byDay) assert.equal(total, 120, `${day}: each day under its own cap`);
});

test('rewards: mastery thresholds once per leaf tag, with evidence; baseline pays nothing', () => {
  const { app, ids, t0, session, attempt, events } = rewardsFixture();
  const tag = app.tags.resolve('bio > cells').tag_id!;
  const parent = app.tags.resolve('bio').tag_id!;
  const setTheta = (p: number) => {
    const theta = Math.log(p / (1 - p));
    app.db.prepare('INSERT INTO ability(tag_id, theta, n, updated_at) VALUES(?,?,?,?) ON CONFLICT(tag_id) DO UPDATE SET theta = excluded.theta').run(tag, theta, 20, Date.now());
    app.db.prepare('INSERT INTO ability(tag_id, theta, n, updated_at) VALUES(?,?,?,?) ON CONFLICT(tag_id) DO UPDATE SET theta = excluded.theta').run(parent, theta, 20, Date.now());
  };
  setTheta(0.75);
  // Evidence: only one study day so far.
  const sid = session(t0 + HOUR, t0 + 2 * HOUR);
  for (let i = 0; i < 12; i++) attempt(sid, ids[i], t0 + HOUR + (i + 1) * MIN);
  assert.equal(app.rewards.tick(t0 + 3 * HOUR).mastery, 0, 'needs two study days');
  const sid2 = session(t0 + 2 * DAY, t0 + 2 * DAY + HOUR);
  attempt(sid2, ids[12], t0 + 2 * DAY + MIN);
  assert.equal(app.rewards.tick(t0 + 2 * DAY + 2 * HOUR).mastery, 2, '50 and 70 for the leaf only');
  const m = events().filter((e) => e.kind === 'mastery_up').map((e) => e.event_id).sort();
  assert.deepEqual(m, [`socrates:mastery:${tag}:50`, `socrates:mastery:${tag}:70`]);
  setTheta(0.9);
  assert.equal(app.rewards.tick(t0 + 3 * DAY).mastery, 1, '85 once');
  setTheta(0.4);
  setTheta(0.9);
  assert.equal(app.rewards.tick(t0 + 4 * DAY).mastery, 0, 'never again for the same threshold');

  // Switching rewards on when mastery is already high records a baseline and pays nothing.
  const fresh = rewardsFixture();
  const ftag = fresh.app.tags.resolve('bio > cells').tag_id!;
  fresh.app.db.prepare(`DELETE FROM settings WHERE key = 'rewards_started_at'`).run();
  fresh.app.db.prepare('INSERT INTO ability(tag_id, theta, n, updated_at) VALUES(?,?,?,?) ON CONFLICT(tag_id) DO UPDATE SET theta = excluded.theta').run(ftag, 3, 20, Date.now());
  const fs1 = fresh.session(fresh.t0 - 3 * DAY, fresh.t0 - 3 * DAY + HOUR);
  for (let i = 0; i < 10; i++) fresh.attempt(fs1, fresh.ids[i], fresh.t0 - 3 * DAY + (i + 1) * MIN);
  const fs2 = fresh.session(fresh.t0 - DAY, fresh.t0 - DAY + HOUR);
  fresh.attempt(fs2, fresh.ids[10], fresh.t0 - DAY + MIN);
  assert.equal(fresh.app.rewards.tick(fresh.t0).mastery, 0);
  assert.equal(fresh.events().filter((e) => e.kind === 'mastery_up').length, 0, 'baseline rows are not listed');
});
