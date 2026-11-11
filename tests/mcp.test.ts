process.env.SOCRATES_EMBEDDINGS ??= 'off'; // wording-only here; meaning checks are in engine.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { App } from '../src/core/app.ts';
import { buildMcpServer } from '../src/mcp/server.ts';

async function connect() {
  const app = new App(':memory:');
  const server = buildMcpServer(app);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test-agent', version: '1' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { error: !!r.isError, data: JSON.parse(r.content[0].text) };
  };
  return { app, client, call };
}

test('MCP: tool list, instructions and prompts', async () => {
  const { client } = await connect();
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ['get_tag_tree', 'resolve_tags', 'create_tags', 'add_questions', 'update_question', 'list_pending_grades', 'submit_grades', 'get_weak_areas', 'get_recent_mistakes', 'create_quiz'])
    assert.ok(tools.includes(t), `missing tool ${t}`);
  assert.match(client.getInstructions() ?? '', /get_tag_tree/);
  const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
  assert.deepEqual(prompts.sort(), ['generate_targeted_questions', 'grade_pending']);
});

test('MCP: agent workflow with strict tagging, dedup, grading and audit', async () => {
  const { app, call } = await connect();
  let r = await call('create_tags', { items: [{ path: 'Physics > Mechanics > Kinematics' }, { path: 'Physics > Mechanics > Kinematic' }] });
  assert.equal(r.data.results[0].status, 'created');
  assert.equal(r.data.results[1].status, 'exists', 'singular/plural normalize to the same tag');
  r = await call('create_tags', { items: [{ path: 'Physics > Mechanic > Kinematics' }] });
  assert.equal(r.data.results[0].status, 'exists');
  r = await call('create_tags', { items: [{ path: 'Physics > Mechanics > Kinemtics' }] });
  assert.equal(r.data.results[0].status, 'refused');
  assert.equal(r.data.results[0].suggestions[0].path, 'physics/mechanics/kinematics');

  r = await call('add_questions', {
    items: [
      { type: 'numeric', prompt: 'A ball falls from rest for 2 s. Speed in m/s? ($g = 9.8$)', answer: 19.6, tolerance: 0.1, unit: 'm/s', tags: ['physics > mechanics > kinematics'], client_ref: 'q1' },
      { type: 'short_answer', prompt: 'Explain why a feather and a hammer fall together on the Moon.', model_answer: 'No air resistance; gravitational acceleration is independent of mass.', rubric: [{ criterion: 'No air resistance', points: 1 }, { criterion: 'Acceleration independent of mass', points: 1 }], tags: ['Physics > Gravity'], client_ref: 'q2' },
    ],
  });
  assert.equal(r.data.results[0].status, 'created');
  assert.equal(r.data.results[1].status, 'unresolved_tags');
  assert.deepEqual(r.data.results[1].tags[0].missing, ['Gravity']);

  await call('create_tags', { items: [{ path: 'Physics > Gravity' }] });
  r = await call('add_questions', {
    items: [
      { type: 'numeric', prompt: 'A ball falls from rest for 2 s. Speed in m/s? ($g = 9.8$)', answer: 19.6, tags: ['physics/mechanics/kinematics'], client_ref: 'q1' },
      { type: 'short_answer', prompt: 'Explain why a feather and a hammer fall together on the Moon.', model_answer: 'No air resistance; gravitational acceleration is independent of mass.', rubric: [{ criterion: 'No air resistance', points: 1 }, { criterion: 'Acceleration independent of mass', points: 1 }], tags: ['Physics > Gravity'], client_ref: 'q2' },
    ],
  });
  assert.equal(r.data.results[0].status, 'exists', 'client_ref makes retries idempotent');
  assert.equal(r.data.results[1].status, 'created');
  assert.equal(r.data.results[1].question_status, 'draft', 'agent questions start as drafts');
  const saId = r.data.results[1].id;

  // Approve drafts, study, then grade the free-text answer through MCP.
  app.questions.setStatus([saId], 'active');
  const numericId = app.questions.search({ type: ['numeric'] }).items[0].id;
  app.questions.setStatus([numericId], 'active');
  const s = app.study.startSession({ mode: 'practice' });
  app.study.submit({ session_id: s.session_id, question_id: numericId, response: { value: '9.8' }, shown_at: Date.now(), time_ms: 9000, confidence: 4 });
  const pending = app.study.submit({ session_id: s.session_id, question_id: saId, response: { text: 'Because there is no air.' }, shown_at: Date.now(), time_ms: 40000 });

  r = await call('list_pending_grades');
  assert.equal(r.data.pending.length, 1);
  assert.equal(r.data.pending[0].response, 'Because there is no air.');
  r = await call('submit_grades', { grades: [{ attempt_id: pending.attempt_id, score: 0.5, feedback: 'Right about air; missing that acceleration does not depend on mass.', rubric_scores: [{ criterion: 'No air resistance', points: 1 }, { criterion: 'Acceleration independent of mass', points: 0 }] }] });
  assert.equal(r.data.results[0].status, 'graded');

  r = await call('get_recent_mistakes');
  assert.equal(r.data.mistakes.length, 2);
  assert.ok(r.data.mistakes.some((m: any) => m.feedback?.includes('missing')));
  r = await call('get_performance_summary');
  assert.equal(r.data.overall.attempts, 2);
  r = await call('get_tag_tree', { with_stats: true });
  assert.ok(r.data.tags.find((t: any) => t.path === 'physics').subtree_questions >= 2);

  // Edits are versioned and revertible through the audit log.
  r = await call('update_question', { id: numericId, changes: { answer: 20 } });
  assert.equal(r.data.edit_kind, 'major');
  const entry = app.auditLog().find((e) => e.tool === 'update_question')!;
  assert.match(entry.actor, /agent:test-agent/);
  app.revert(entry.id);
  assert.equal(app.questions.get(numericId)!.spec.answer, 19.6);

  // Validation errors are specific enough to fix.
  r = await call('add_questions', { items: [{ type: 'mcq_single', prompt: 'Pick one', options: ['a', 'b'], correct: 5, tags: ['physics'] }] });
  assert.match(r.data.results[0].errors[0], /out of range/);

  r = await call('create_quiz', { tags: ['physics'], limit: 5 });
  assert.match(r.data.url, /\/study\/\d+$/);
});
