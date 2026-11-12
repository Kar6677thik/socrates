import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { App } from '../core/app.ts';
import { backupIfDue, backup } from '../core/db.ts';
import { buildMcpServer } from '../mcp/server.ts';
import { TagError } from '../core/tags.ts';
import { QTYPES, TYPE_LABELS, codeAutoGraded } from '../core/qtypes.ts';
import { runJs, redact } from '../core/coderun.ts';
import { saveImage, fetchImage, decodeBase64, mimeFor, mediaDir } from '../core/media.ts';
import { optimize, applyWeights } from '../core/optimize.ts';
import { upload, preview as importPreview, commit as importCommit, exportJson, FORMATS, type ImportFormat } from '../core/importer.ts';
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = join(ROOT, 'web', 'dist');
const PORT = Number(process.env.PORT ?? 4321);
const HOST = process.env.HOST ?? '127.0.0.1';

const app = new App();
const api = new Hono();

const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

// The UI API is local-only: refuse other Host headers (DNS rebinding, tunnels) and
// non-JSON writes (forces a CORS preflight, which we never grant, for cross-site requests).
api.use('*', async (c, next) => {
  if (!LOCAL_HOSTS.test(c.req.header('host') ?? '')) return c.json({ error: 'The app API is only available on localhost.' }, 403);
  const ct = c.req.header('content-type') ?? '';
  // File uploads send raw bytes; octet-stream also forces a preflight, so the CSRF guard holds.
  const binaryOk = c.req.path.endsWith('/import/upload') && ct.startsWith('application/octet-stream');
  if (c.req.method !== 'GET' && !ct.includes('application/json') && !binaryOk)
    return c.json({ error: 'Content-Type must be application/json' }, 415);
  await next();
});

api.onError((e: any, c) => {
  const status = e instanceof TagError || e.name === 'ZodError' || /not found|invalid|must|cannot|already|unresolved/i.test(e.message) ? 400 : 500;
  if (status === 500) console.error(e);
  return c.json({ error: e.message, details: e.details ?? e.issues }, status);
});

const num = (s: string) => {
  const n = Number(s);
  if (!Number.isInteger(n)) throw new Error('invalid id');
  return n;
};
const list = (s?: string) => (s ? s.split(',').filter(Boolean) : undefined);

// ---- Home & meta
api.get('/home', (c) => c.json(app.stats.home()));
api.get('/meta', (c) => c.json({ types: QTYPES.map((t) => ({ id: t, label: TYPE_LABELS[t] })) }));
api.get('/settings', (c) => c.json(app.settings()));
api.patch('/settings', async (c) => c.json(app.updateSettings(await c.req.json())));
// ---- Schedule optimization (FSRS weights fitted to your history)
api.get('/schedule', (c) => c.json(app.scheduleInfo()));
api.post('/schedule/optimize', async (c) => c.json(await optimize(app.db)));
api.post('/schedule/weights', async (c) => {
  const b = await c.req.json();
  return c.json(applyWeights(app.db, b.weights ?? null, app.settings().retention));
});
api.get('/mcp-info', (c) => {
  const token = app.mcpToken();
  const stdio = join(ROOT, 'src', 'mcp', 'stdio.ts');
  return c.json({
    token,
    http_url: `http://localhost:${PORT}/mcp`,
    path_token_url: `http://localhost:${PORT}/mcp/t/${token}`,
    stdio_command: { command: 'node', args: ['--no-warnings', stdio] },
    claude_code: `claude mcp add socrates -s user -- node --no-warnings "${stdio}"`,
  });
});

// ---- Tags
api.get('/tags', (c) => c.json(app.tags.tree({ withStats: true })));
api.post('/tags', async (c) => {
  const b = await c.req.json();
  return c.json(app.tags.create(b.path, { description: b.description, force: b.force, justification: b.justification ?? (b.force ? 'created by user' : undefined) }));
});
api.get('/tags/resolve', (c) => c.json(app.tags.resolve(c.req.query('path') ?? '')));
api.post('/tags/merge', async (c) => {
  const b = await c.req.json();
  return c.json(app.tags.merge(b.source_id, b.target_id));
});
api.post('/tags/:id/alias', async (c) => c.json(app.tags.addAlias(num(c.req.param('id')), (await c.req.json()).alias)));
api.post('/tags/:id/move', async (c) => c.json(app.tags.move(num(c.req.param('id')), (await c.req.json()).parent ?? null)));
api.post('/tags/:id/rename', async (c) => {
  const b = await c.req.json();
  return c.json(app.tags.rename(num(c.req.param('id')), b.name, b.description));
});
api.delete('/tags/:id', (c) => {
  const ok = app.tags.deleteIfUnused(num(c.req.param('id')));
  if (!ok) throw new Error('Tag cannot be deleted: it has questions or children. Merge it instead.');
  return c.json({ ok });
});

// ---- Questions
api.get('/questions', (c) => {
  const q = c.req.query();
  return c.json(
    app.questions.search({
      query: q.q, tags: list(q.tags), type: list(q.types) as any, status: list(q.status) as any,
      flagged: q.flagged === '1', limit: q.limit ? Number(q.limit) : 50, offset: q.offset ? Number(q.offset) : 0,
    }),
  );
});
api.get('/questions/:id', (c) => {
  const id = num(c.req.param('id'));
  const q = app.questions.get(id);
  if (!q) throw new Error('Question not found');
  const attempts = app.db
    .prepare('SELECT id, score, is_correct, grade_status, time_ms, confidence, hints_used, answer_changes, answered_at, rating FROM attempts WHERE question_id = ? ORDER BY id DESC LIMIT 50')
    .all(id);
  const card = app.db.prepare('SELECT due, state, reps, lapses, card FROM srs_cards WHERE question_id = ?').get(id) as any;
  return c.json({ question: q, versions: app.questions.versions(id).map(({ snapshot, ...v }) => v), attempts, srs: card ? { ...card, card: JSON.parse(card.card) } : null });
});
api.post('/questions', async (c) => {
  const b = await c.req.json();
  return c.json(await app.questions.addAsync(Array.isArray(b) ? b : b.items ?? [b], { actor: 'user', dryRun: b.dry_run }));
});
api.patch('/questions/:id', async (c) => {
  const b = await c.req.json();
  const { edit_kind, ...patch } = b;
  const r = app.questions.update(num(c.req.param('id')), patch, { editKind: edit_kind });
  app.backfillEmbeddings();
  return c.json(r);
});
api.post('/questions/status', async (c) => {
  const b = await c.req.json();
  return c.json({ changed: app.questions.setStatus(b.ids, b.status) });
});
api.post('/questions/:id/flag', async (c) => {
  app.questions.flag(num(c.req.param('id')), (await c.req.json()).reason ?? null);
  return c.json({ ok: true });
});
api.post('/questions/:id/restore', async (c) => c.json(app.questions.restore(num(c.req.param('id')), (await c.req.json()).version)));
api.get('/questions/:id/hint/:i', (c) => c.json({ hint: app.study.hint(num(c.req.param('id')), num(c.req.param('i'))) }));

// ---- Study
api.post('/sessions', async (c) => c.json(app.study.startSession(await c.req.json())));
api.get('/sessions/:id', (c) => c.json(app.study.loadSession(num(c.req.param('id')))));
api.post('/sessions/:id/end', (c) => c.json(app.study.endSession(num(c.req.param('id')))));
api.post('/attempts', async (c) => c.json(await app.study.submitAsync(await c.req.json())));
/** Run JavaScript code against a question's visible + hidden tests without recording an attempt. */
api.post('/code/run', async (c) => {
  const b = await c.req.json();
  const q = app.questions.get(num(String(b.question_id)));
  if (!q || q.type !== 'code' || !codeAutoGraded(q.spec)) throw new Error('This question has no runnable tests.');
  return c.json(redact(await runJs(String(b.code ?? ''), q.spec.tests, q.spec.function_name ?? 'solution')));
});
/** Editor: run a draft's tests against its reference solution before saving. */
api.post('/code/check', async (c) => {
  const b = await c.req.json();
  return c.json(await runJs(String(b.code ?? ''), b.tests ?? [], b.function_name || 'solution'));
});
api.post('/media', async (c) => {
  const b = await c.req.json();
  return c.json(b.url ? saveImage(await fetchImage(String(b.url))) : saveImage(decodeBase64(String(b.data ?? ''))));
});
api.post('/attempts/:id/undo', (c) => c.json(app.study.undo(num(c.req.param('id')))));
api.get('/recommendations', (c) => c.json(app.stats.recommendations()));
api.get('/analytics', (c) => c.json(app.stats.analytics({ days: c.req.query('days') ? Number(c.req.query('days')) : undefined, tag: c.req.query('tag') || undefined })));
api.get('/presets', (c) => c.json(app.presets()));
api.put('/presets', async (c) => c.json(app.savePresets(await c.req.json())));
api.get('/grades/pending', (c) => c.json(app.study.pendingGrades(100)));
api.post('/grades/:attemptId', async (c) => {
  const b = await c.req.json();
  return c.json(app.study.grade(num(c.req.param('attemptId')), { score: b.score, feedback: b.feedback, grader: 'self' }));
});
api.get('/attempts/:id/grades', (c) =>
  c.json(app.db.prepare('SELECT * FROM grades WHERE attempt_id = ? ORDER BY id DESC').all(num(c.req.param('id')))),
);

// ---- Import / export
api.post('/import/upload', async (c) => {
  const name = c.req.query('name') ?? 'upload';
  const format = c.req.query('format') as ImportFormat | undefined;
  if (format && !FORMATS.includes(format)) throw new Error('Invalid format');
  return c.json(upload(name, Buffer.from(await c.req.arrayBuffer()), format));
});
api.post('/import/preview', async (c) => {
  const b = await c.req.json();
  return c.json(importPreview(app.tags, String(b.token), b.options ?? {}));
});
api.post('/import/commit', async (c) => {
  const b = await c.req.json();
  const r = await importCommit(app, String(b.token), b.options ?? {}, b.tag_map ?? {});
  app.backfillEmbeddings();
  return c.json(r);
});
api.get('/export/json', (c) => {
  const day = new Date().toISOString().slice(0, 10);
  return c.body(JSON.stringify(exportJson(app.db)), 200, {
    'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="socrates-export-${day}.json"`,
  });
});
/** A consistent snapshot of the whole database (history included), written to a temp file and streamed. */
api.get('/export/db', (c) => {
  const dir = mkdtempSync(join(tmpdir(), 'socrates-export-'));
  const file = join(dir, 'socrates.db');
  try {
    app.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    const data = readFileSync(file);
    const day = new Date().toISOString().slice(0, 10);
    return c.body(data, 200, { 'Content-Type': 'application/vnd.sqlite3', 'Content-Disposition': `attachment; filename="socrates-${day}.db"` });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
api.get('/backups', (c) => {
  const dir = join(dirname(app.dbPath), 'backups');
  if (!existsSync(dir)) return c.json({ dir, items: [] });
  const items = readdirSync(dir).filter((f) => f.endsWith('.db')).map((f) => {
    const s = statSync(join(dir, f));
    return { name: f, bytes: s.size, at: s.mtimeMs };
  }).sort((a, b) => b.at - a.at);
  return c.json({ dir, items });
});
api.post('/backups', (c) => c.json({ file: backup(app.db, app.dbPath, 'manual') }));

// ---- Audit
api.get('/audit', (c) => c.json(app.auditLog(Number(c.req.query('limit') ?? 100))));
api.post('/audit/:id/revert', (c) => c.json({ ok: true, detail: app.revert(num(c.req.param('id'))) }));

// ---- MCP over HTTP (stateless). Always requires the token: a tunnel makes remote requests look local.
const root = new Hono();
const tokenOk = (given: string | undefined) => {
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(app.mcpToken());
  return a.length === b.length && timingSafeEqual(a, b);
};
const handleMcp = async (req: Request) => {
  // e.g. "openai-mcp/1.0" -> "openai-mcp", "claude-code/2.1" -> "claude-code"
  const ua = (req.headers.get('user-agent') ?? '').split(/[\s/]/)[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const server = buildMcpServer(app, { fallbackClient: ua || 'http' });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
};
root.all('/mcp', async (c) => {
  const auth = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!tokenOk(auth)) return c.json({ error: 'Missing or invalid bearer token' }, 401);
  return handleMcp(c.req.raw);
});
root.all('/mcp/t/:token', async (c) => {
  if (!tokenOk(c.req.param('token'))) return c.json({ error: 'Invalid token' }, 401);
  return handleMcp(c.req.raw);
});

root.route('/api', api);

// Uploaded images: local only, immutable (content-addressed names).
root.get('/media/:file', (c) => {
  if (!LOCAL_HOSTS.test(c.req.header('host') ?? '')) return c.text('Not found', 404);
  const file = c.req.param('file');
  const type = mimeFor(file);
  if (!/^[a-f0-9]{32}\.[a-z]+$/.test(file) || !type || !existsSync(join(mediaDir(), file))) return c.text('Not found', 404);
  return c.body(readFileSync(join(mediaDir(), file)), 200, {
    'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
  });
});

// ---- Static UI (built). In dev, Vite serves the UI and proxies /api here.
if (existsSync(DIST)) {
  // Read per request (it's tiny) so a rebuild never leaves the server pointing at deleted assets.
  const index = () => readFileSync(join(DIST, 'index.html'), 'utf8');
  root.use('/assets/*', serveStatic({ root: relative(process.cwd(), DIST).replace(/\\/g, '/') || '.', onFound: (_p, c) => { c.header('Cache-Control', 'public, max-age=31536000, immutable'); } }));
  root.use('/*', serveStatic({ root: relative(process.cwd(), DIST).replace(/\\/g, '/') || '.' }));
  root.get('*', (c) => c.html(index()));
} else {
  root.get('/', (c) => c.text('UI not built. Run `npm run build`, or use `npm run dev` and open http://localhost:5173'));
}

setInterval(() => { try { backupIfDue(app.db, app.dbPath); } catch {} }, 3600_000).unref();
// Embed any questions that don't have a vector yet (first run, offline adds, edits).
setTimeout(() => app.backfillEmbeddings(), 1500).unref();

serve({ fetch: root.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`Socrates  http://localhost:${PORT}`);
  console.log(`MCP HTTP  http://localhost:${PORT}/mcp  (bearer token: Settings > Connect)`);
});
