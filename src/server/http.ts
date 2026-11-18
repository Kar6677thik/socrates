// HTTP surface. Two Hono apps:
//   ui   UI + JSON API + owner login + health. Local: also /mcp with the local bearer token.
//   mcp  (only with OAuth configured) /mcp with Orbit Identity tokens, its discovery documents and health.
//        Nothing else: a misrouted public request can never reach the UI or the API.
import { Hono, type Context } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { existsSync, readFileSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { App } from '../core/app.ts';
import { backup } from '../core/db.ts';
import { buildMcpServer } from '../mcp/server.ts';
import { TagError } from '../core/tags.ts';
import { QTYPES, TYPE_LABELS, codeAutoGraded } from '../core/qtypes.ts';
import { runJs, redact } from '../core/coderun.ts';
import { saveImage, fetchImage, decodeBase64, mimeFor, mediaDir } from '../core/media.ts';
import { optimize, applyWeights } from '../core/optimize.ts';
import { upload, preview as importPreview, commit as importCommit, exportJson, FORMATS, type ImportFormat } from '../core/importer.ts';
import type { Config } from './config.ts';
import { SESSION_COOKIE, type Owner } from './owner.ts';
import { challenge, resourceMetadata, type TokenCheck } from './oauth.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = process.env.SOCRATES_UI_DIR ?? join(ROOT, 'web', 'dist');
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface Deps {
  owner: Owner | null;
  verifyToken: ((token: string | undefined) => Promise<TokenCheck>) | null;
}

/** The TCP peer. @hono/node-server passes the Node request as env.incoming; tests pass env.remoteAddress. */
function peer(c: Context): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } }; remoteAddress?: string } | undefined;
  return (env?.incoming?.socket?.remoteAddress ?? env?.remoteAddress ?? '').replace(/^::ffff:/, '');
}

/** HTTPS as seen by the client: X-Forwarded-Proto counts only from a trusted proxy. */
function viaHttps(c: Context, cfg: Config): boolean {
  if (!cfg.trustedProxies.includes(peer(c))) return false;
  return (c.req.header('x-forwarded-proto') ?? '').split(',')[0].trim().toLowerCase() === 'https';
}

const hostAllowed = (host: string | undefined, allowed: string[]) =>
  !!host && (LOCAL_HOST.test(host) || allowed.some((h) => h.toLowerCase() === host.toLowerCase()));

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function securityHeaders(c: Context) {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
}

function health(r: Hono, app: App) {
  r.get('/health/live', (c) => c.json({ status: 'Healthy' }));
  r.get('/health/ready', (c) => {
    try {
      app.db.prepare('SELECT 1').get();
      return c.json({ status: 'Ready' });
    } catch {
      return c.json({ status: 'NotReady' }, 503);
    }
  });
}

/** One stateless MCP server per request. scopes undefined = fully trusted local caller. */
async function handleMcp(app: App, req: Request, scopes?: ReadonlySet<string>) {
  // e.g. "openai-mcp/1.0" -> "openai-mcp", "claude-code/2.1" -> "claude-code"
  const ua = (req.headers.get('user-agent') ?? '').split(/[\s/]/)[0].toLowerCase().replace(/[^a-z0-9._-]/g, '');
  const server = buildMcpServer(app, { fallbackClient: ua || 'http', scopes });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export function createServers(app: App, cfg: Config, deps: Deps): { ui: Hono; mcp: Hono | null } {
  return { ui: uiServer(app, cfg, deps), mcp: cfg.oauth && deps.verifyToken ? mcpServer(app, cfg, deps.verifyToken) : null };
}

// ======================================================================================= UI listener

function uiServer(app: App, cfg: Config, deps: Deps): Hono {
  const { owner } = deps;
  const localMcp = !cfg.deployed && !cfg.oauth;
  const uiOrigins = new Set([...(cfg.publicOrigin ? [cfg.publicOrigin] : []), ...(cfg.deployed ? [] : [`http://localhost:${cfg.port}`, `http://127.0.0.1:${cfg.port}`, 'http://localhost:5173', 'http://127.0.0.1:5173'])]);
  const root = new Hono();

  root.use('*', async (c, next) => {
    await next();
    securityHeaders(c);
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/health/')) c.header('Cache-Control', 'no-store');
  });
  health(root, app);

  // Exact Host only (DNS rebinding, stray tunnels), then HTTPS when deployed.
  root.use('*', async (c, next) => {
    if (!hostAllowed(c.req.header('host'), cfg.allowedHosts)) return c.json({ error: 'Unknown host.' }, 403);
    if (cfg.deployed && !viaHttps(c, cfg)) return c.json({ error: 'HTTPS is required.' }, 403);
    await next();
  });

  // Owner session: required for the API (except the session endpoints) and media. The static UI loads without it
  // and shows the sign-in screen.
  const signedIn = (c: Context) => !owner || owner.check(getCookie(c, SESSION_COOKIE));
  root.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/session') return next();
    if (!signedIn(c)) return c.json({ error: 'Sign in to continue.', code: 'signin' }, 401);
    await next();
  });
  root.use('/media/*', async (c, next) => {
    if (!signedIn(c)) return c.text('Not found', 404);
    await next();
  });

  const api = new Hono();

  // Cross-site write protection: unsafe methods need a JSON (or, for uploads, octet-stream) body, which forces a
  // CORS preflight we never grant, an Origin equal to the UI's when one is sent, and no cross-site fetch metadata.
  api.use('*', async (c, next) => {
    if (UNSAFE.has(c.req.method)) {
      const ct = c.req.header('content-type') ?? '';
      const binaryOk = c.req.path.endsWith('/import/upload') && ct.startsWith('application/octet-stream');
      if (!ct.includes('application/json') && !binaryOk) return c.json({ error: 'Content-Type must be application/json' }, 415);
      const origin = c.req.header('origin');
      const site = c.req.header('sec-fetch-site');
      if ((origin !== undefined && !uiOrigins.has(origin)) || site === 'cross-site' || site === 'same-site')
        return c.json({ error: 'Cross-site request refused.' }, 403);
    }
    await next();
  });

  // ---- Session
  api.get('/session', (c) => c.json({ signedIn: signedIn(c), loginRequired: !!owner }));
  api.post('/session', bodyLimit({ maxSize: 4096 }), async (c) => {
    if (!owner) return c.json({ error: 'Sign-in is not configured.' }, 503);
    const b = await c.req.json().catch(() => ({}));
    const r = await owner.login(b.password, b.code);
    if (!r.ok) return c.json({ error: r.error }, r.status);
    setCookie(c, SESSION_COOKIE, r.session, { path: '/', secure: true, httpOnly: true, sameSite: 'Strict' });
    return c.json({ signedIn: true });
  });
  api.delete('/session', (c) => {
    owner?.logout(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
    return c.json({ signedIn: false });
  });

  const num = (s: string) => {
    const n = Number(s);
    if (!Number.isInteger(n)) throw new Error('invalid id');
    return n;
  };
  const list = (s?: string) => (s ? s.split(',').filter(Boolean) : undefined);
  const mcpInfo = () => {
    const stdio = join(ROOT, 'src', 'mcp', 'stdio.ts');
    const base = {
      mode: localMcp ? 'local' : cfg.oauth ? 'oauth' : 'off',
      stdio_command: { command: 'node', args: ['--no-warnings', stdio] },
      claude_code: `claude mcp add socrates -s user -- node --no-warnings "${stdio}"`,
    };
    if (cfg.oauth) return { ...base, oauth_url: cfg.oauth.resource, claude_code: `claude mcp add --transport http socrates ${cfg.oauth.resource}` };
    if (!localMcp) return base;
    const token = app.mcpToken();
    return {
      ...base,
      token,
      http_url: `http://localhost:${cfg.port}/mcp`,
      path_token_url: `http://localhost:${cfg.port}/mcp/t/${token}`,
    };
  };

  api.onError((e: any, c) => {
    const status = e instanceof TagError || e.name === 'ZodError' || /not found|invalid|must|cannot|already|unresolved/i.test(e.message) ? 400 : 500;
    if (status === 500) console.error(e);
    return c.json({ error: e.message, details: e.details ?? e.issues }, status);
  });

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
  api.get('/mcp-info', (c) => c.json(mcpInfo()));

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

  // ---- Study rewards (read-only: what Hey Ann will be sent once a transport exists)
  api.get('/rewards', (c) => c.json({ events: app.rewards.list({ limit: Math.min(200, Number(c.req.query('limit') ?? 50) || 50) }) }));

  // ---- Audit
  api.get('/audit', (c) => c.json(app.auditLog(Number(c.req.query('limit') ?? 100))));
  api.post('/audit/:id/revert', (c) => c.json({ ok: true, detail: app.revert(num(c.req.param('id'))) }));

  root.route('/api', api);

  // ---- MCP with the local token (local mode only). Always requires the token: a tunnel makes remote requests look local.
  if (localMcp) {
    const tokenOk = (given: string | undefined) => !!given && safeEqual(given, app.mcpToken());
    root.all('/mcp', async (c) => {
      const auth = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
      if (!tokenOk(auth)) return c.json({ error: 'Missing or invalid bearer token' }, 401);
      return handleMcp(app, c.req.raw);
    });
    root.all('/mcp/t/:token', async (c) => {
      if (!tokenOk(c.req.param('token'))) return c.json({ error: 'Invalid token' }, 401);
      return handleMcp(app, c.req.raw);
    });
  }

  // Uploaded images: immutable (content-addressed names).
  root.get('/media/:file', (c) => {
    const file = c.req.param('file');
    const type = mimeFor(file);
    if (!/^[a-f0-9]{32}\.[a-z]+$/.test(file) || !type || !existsSync(join(mediaDir(), file))) return c.text('Not found', 404);
    return c.body(readFileSync(join(mediaDir(), file)), 200, {
      'Content-Type': type, 'Cache-Control': 'private, max-age=31536000, immutable',
    });
  });
  root.all('/mcp/*', (c) => c.json({ error: 'Not found' }, 404));
  root.all('/mcp', (c) => c.json({ error: 'Not found' }, 404));

  // ---- Static UI (built). In dev, Vite serves the UI and proxies /api here.
  if (existsSync(DIST)) {
    const staticRoot = relative(process.cwd(), DIST).replace(/\\/g, '/') || '.';
    // Read per request (it's tiny) so a rebuild never leaves the server pointing at deleted assets.
    const index = () => readFileSync(join(DIST, 'index.html'), 'utf8');
    root.use('/assets/*', serveStatic({ root: staticRoot, onFound: (_p, c) => { c.header('Cache-Control', 'public, max-age=31536000, immutable'); } }));
    root.use('/*', serveStatic({ root: staticRoot }));
    root.get('*', (c) => c.html(index()));
  } else {
    root.get('/', (c) => c.text('UI not built. Run `npm run build`, or use `npm run dev` and open http://localhost:5173'));
  }
  return root;
}

// ======================================================================================= MCP listener

function mcpServer(app: App, cfg: Config, verify: (token: string | undefined) => Promise<TokenCheck>): Hono {
  const oauth = cfg.oauth!;
  const origin = cfg.mcpPublicOrigin!;
  const hosts = [new URL(origin).host];
  const browserOrigins = new Set([origin, ...cfg.mcpAllowedOrigins]);
  const root = new Hono();
  const PER_MINUTE = 90;
  const windows = new Map<string, { start: number; n: number }>();
  const limited = (key: string) => {
    const t = Date.now();
    const w = windows.get(key);
    if (!w || t - w.start >= 60_000) {
      if (windows.size > 1000) windows.clear();
      windows.set(key, { start: t, n: 1 });
      return false;
    }
    return ++w.n > PER_MINUTE;
  };

  root.use('*', async (c, next) => {
    await next();
    securityHeaders(c);
    c.header('Cache-Control', 'no-store');
  });
  health(root, app);
  root.use('*', async (c, next) => {
    if (!hostAllowed(c.req.header('host'), hosts)) return c.json({ error: 'Unknown host.' }, 403);
    if (!viaHttps(c, cfg)) return c.json({ error: 'HTTPS is required.' }, 403);
    const o = c.req.header('origin');
    if (o !== undefined && !browserOrigins.has(o)) return c.json({ error: 'The request origin is not allowed.' }, 403);
    await next();
  });

  const metadata = (c: Context) => c.json(resourceMetadata(oauth));
  root.get('/.well-known/oauth-protected-resource', metadata);
  root.get('/.well-known/oauth-protected-resource/mcp', metadata);

  root.all('/mcp', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'Request too large.' }, 413) }), async (c) => {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    const r = await verify(m?.[1]);
    if (!r.ok) {
      c.header('WWW-Authenticate', challenge(origin));
      return c.json({ error: 'A valid Orbit Identity access token is required.' }, 401);
    }
    if (![...r.scopes].some((s) => s.startsWith('socrates.'))) {
      c.header('WWW-Authenticate', `${challenge(origin)}, error="insufficient_scope"`);
      return c.json({ error: 'The token has no Socrates scopes.' }, 403);
    }
    if (limited(r.sub)) return c.json({ error: 'Too many requests.' }, 429);
    return handleMcp(app, c.req.raw, r.scopes);
  });

  root.all('*', (c) => c.json({ error: 'Not found' }, 404));
  return root;
}
