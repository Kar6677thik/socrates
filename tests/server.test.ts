process.env.SOCRATES_EMBEDDINGS ??= 'off';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPair, exportJWK, SignJWT, type CryptoKey } from 'jose';
import { App } from '../src/core/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { Owner, makeVerifier, toBase32, totpCode, totpStep, parseVerifier, verifyPassword } from '../src/server/owner.ts';
import { tokenVerifier, loadJwks } from '../src/server/oauth.ts';
import { createServers } from '../src/server/http.ts';

const dir = mkdtempSync(join(tmpdir(), 'socrates-server-test-'));
const UI = 'https://socrates.example.ts.net';
const MCP = 'https://socrates-mcp.example.com';
const ISSUER = 'https://auth.example.com/';
const OWNER_SUB = '7356e980-0000-4c82-84f1-b00c5f9783f0';
const PROXY = '10.42.0.1';
const secret = Buffer.alloc(20, 7);

const { publicKey, privateKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', use: 'sig', alg: 'ES256' };
const jwksFile = join(dir, 'jwks.json');
writeFileSync(jwksFile, JSON.stringify({ keys: [jwk] }));
const credentialFile = join(dir, 'verifier');
writeFileSync(credentialFile, await makeVerifier('correct horse', 100_000));
const totpFile = join(dir, 'totp');
writeFileSync(totpFile, toBase32(secret));

const deployedEnv = {
  SOCRATES_PUBLIC_ORIGIN: UI,
  SOCRATES_TRUSTED_PROXY: PROXY,
  SOCRATES_CREDENTIAL_FILE: credentialFile,
  SOCRATES_TOTP_FILE: totpFile,
  SOCRATES_MCP_PORT: '8081',
  SOCRATES_MCP_PUBLIC_ORIGIN: MCP,
  SOCRATES_OAUTH_ISSUER: ISSUER,
  SOCRATES_OAUTH_RESOURCE: `${MCP}/mcp`,
  SOCRATES_OAUTH_ALLOWED_SUBJECTS: OWNER_SUB,
  SOCRATES_OAUTH_JWKS_FILE: jwksFile,
  SOCRATES_MCP_ALLOWED_ORIGINS: 'https://claude.ai',
  PORT: '8080',
};

function deployed() {
  const cfg = loadConfig(deployedEnv);
  const app = new App(':memory:');
  const owner = Owner.fromFiles(credentialFile, totpFile);
  const servers = createServers(app, cfg, { owner, verifyToken: tokenVerifier(cfg.oauth!) });
  const env = { remoteAddress: PROXY };
  const ui = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    servers.ui.request(`http://10.43.0.105:8080${path}`, { ...init, headers: { host: 'socrates.example.ts.net', 'x-forwarded-proto': 'https', ...init.headers } }, env);
  const mcp = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    servers.mcp!.request(`http://10.43.0.105:8081${path}`, { ...init, headers: { host: 'socrates-mcp.example.com', 'x-forwarded-proto': 'https', ...init.headers } }, env);
  return { app, cfg, servers, ui, mcp };
}

async function token(claims: Record<string, unknown> = {}, opts: { typ?: string; key?: CryptoKey; exp?: number } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: ISSUER, aud: `${MCP}/mcp`, sub: OWNER_SUB, iat: now, exp: opts.exp ?? now + 900,
    scope: 'socrates.read socrates.write', client_id: 'https://claude.ai/oauth/mcp-oauth-client-metadata', ...claims,
  })
    .setProtectedHeader({ alg: 'ES256', typ: opts.typ ?? 'at+jwt', kid: 'k1' })
    .sign(opts.key ?? privateKey);
}

const rpc = (method: string, params: unknown = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
const mcpHeaders = (tok: string) => ({ authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' });

test('config: local by default; deployed refuses half-secured setups', () => {
  const local = loadConfig({});
  assert.equal(local.deployed, false);
  assert.equal(local.host, '127.0.0.1');
  assert.throws(() => loadConfig({ SOCRATES_PUBLIC_ORIGIN: UI, SOCRATES_TRUSTED_PROXY: PROXY }), /owner login/);
  assert.throws(() => loadConfig({ ...deployedEnv, SOCRATES_PUBLIC_ORIGIN: 'http://socrates.example.ts.net' }), /https/);
  assert.throws(() => loadConfig({ ...deployedEnv, SOCRATES_ALLOWED_HOSTS: '*.ts.net' }), /exact host/);
  assert.throws(() => loadConfig({ ...deployedEnv, SOCRATES_TRUSTED_PROXY: '' }), /TRUSTED_PROXY/);
  assert.throws(() => loadConfig({ ...deployedEnv, SOCRATES_OAUTH_ISSUER: 'https://auth.example.com' }), /issuer/);
  assert.throws(() => loadConfig({ ...deployedEnv, SOCRATES_OAUTH_ALLOWED_SUBJECTS: '' }), /owner subject/);
  assert.throws(() => loadConfig({ ...deployedEnv, SOCRATES_OAUTH_RESOURCE: 'https://other.example.com/mcp' }), /MCP_PUBLIC_ORIGIN/);
  assert.throws(() => loadConfig({ ...deployedEnv, SOCRATES_MCP_PORT: '' }), /SOCRATES_MCP_PORT/);
  // Tailnet-only first: deployed without OAuth is valid, and serves no MCP at all.
  const { SOCRATES_MCP_PORT, SOCRATES_MCP_PUBLIC_ORIGIN, SOCRATES_OAUTH_ISSUER, SOCRATES_OAUTH_RESOURCE, SOCRATES_OAUTH_ALLOWED_SUBJECTS, SOCRATES_OAUTH_JWKS_FILE, ...tailnetOnly } = deployedEnv;
  const t = loadConfig(tailnetOnly);
  assert.equal(t.oauth, null);
  assert.equal(createServers(new App(':memory:'), t, { owner: null, verifyToken: null }).mcp, null);
});

test('owner: Identity V3 verifier and TOTP, single-use codes, lockout', async () => {
  // A known ASP.NET Core Identity V3 hash layout round-trips.
  const v = parseVerifier(await makeVerifier('pw', 100_000));
  assert.equal(v.digest, 'sha512');
  assert.equal(await verifyPassword(v, 'pw'), true);
  assert.equal(await verifyPassword(v, 'pW'), false);
  assert.throws(() => parseVerifier(Buffer.from([1, 0, 0, 0, 2, 0, 0, 0, 10, 0, 0, 0, 16]).toString('base64')), /work factor/);
  // RFC 6238 test vector (SHA-1, T=59 s): 94287082 -> last six digits.
  assert.equal(totpCode(Buffer.from('12345678901234567890'), 1), '287082');

  let now = Date.now();
  const owner = new Owner({ verifier: await makeVerifier('pw', 100_000), totp: toBase32(secret), now: () => now });
  const code = () => totpCode(secret, totpStep(now));
  const ok = await owner.login('pw', code());
  assert.equal(ok.ok, true);
  assert.equal((await owner.login('pw', code())).ok, false, 'a code works once');
  assert.ok(ok.ok && owner.check(ok.session));
  now += 31 * 60_000;
  assert.ok(ok.ok && !owner.check(ok.session), 'idle sessions expire');
  // (The replay above is outside the 15-minute window by now.)
  for (let i = 0; i < 5; i++) assert.equal((await owner.login('wrong', '000000')).ok, false);
  const locked = await owner.login('pw', code());
  assert.ok(!locked.ok && locked.status === 429, 'five failures lock sign-in, even for the right password');
  now += 16 * 60_000;
  assert.equal((await owner.login('pw', code())).ok, true, 'the lock lifts after 15 minutes');
});

test('UI listener: host, HTTPS, login, cross-site and no /mcp', async () => {
  const { ui } = deployed();
  assert.equal((await ui('/health/ready', { headers: { host: '10.42.0.17:8080', 'x-forwarded-proto': '' } })).status, 200, 'probes bypass the checks');
  assert.equal((await ui('/api/home', { headers: { host: 'evil.example.com' } })).status, 403);
  assert.equal((await ui('/api/home', { headers: { 'x-forwarded-proto': 'http' } })).status, 403);
  assert.equal((await ui('/api/home')).status, 401);
  assert.equal((await ui('/media/0123456789abcdef0123456789abcdef.png')).status, 404);
  const s = await (await ui('/api/session')).json();
  assert.deepEqual(s, { signedIn: false, loginRequired: true });

  // HTTPS can't be faked by a client that isn't the proxy.
  const direct = deployed().servers.ui.request('http://x/api/session', { headers: { host: 'socrates.example.ts.net', 'x-forwarded-proto': 'https' } }, { remoteAddress: '10.42.0.99' });
  assert.equal((await direct).status, 403);

  const login = (body: unknown) => ui('/api/session', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', origin: UI } });
  assert.equal((await login({ password: 'nope', code: '000000' })).status, 401);
  const r = await login({ password: 'correct horse', code: totpCode(secret, totpStep(Date.now())) });
  assert.equal(r.status, 200);
  const cookie = r.headers.get('set-cookie')!;
  assert.match(cookie, /^__Host-socrates_session=/);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Secure/i);
  assert.match(cookie, /SameSite=Strict/i);
  const session = cookie.split(';')[0];

  assert.equal((await ui('/api/home', { headers: { cookie: session } })).status, 200);
  const write = (headers: Record<string, string>) =>
    ui('/api/tags', { method: 'POST', body: JSON.stringify({ path: 'math' }), headers: { cookie: session, 'content-type': 'application/json', ...headers } });
  assert.equal((await write({ origin: 'https://evil.example.com' })).status, 403);
  assert.equal((await write({ origin: UI, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await write({ origin: UI, 'content-type': 'text/plain' })).status, 415);
  assert.equal((await write({ origin: UI, 'sec-fetch-site': 'same-origin' })).status, 200);

  const info = await (await ui('/api/mcp-info', { headers: { cookie: session } })).json();
  assert.equal(info.mode, 'oauth');
  assert.equal(info.token, undefined, 'no static token when deployed');
  assert.equal((await ui('/mcp', { method: 'POST', headers: { cookie: session } })).status, 404);
  assert.equal((await ui('/mcp/t/anything')).status, 404);

  assert.equal((await ui('/api/session', { method: 'DELETE', headers: { cookie: session, 'content-type': 'application/json', origin: UI } })).status, 200);
  assert.equal((await ui('/api/home', { headers: { cookie: session } })).status, 401, 'signed out');
});

test('MCP listener: only /mcp and discovery; Orbit Identity tokens checked like Sprawl', async () => {
  const { mcp } = deployed();
  const meta = await (await mcp('/.well-known/oauth-protected-resource')).json();
  assert.deepEqual(meta, { resource: `${MCP}/mcp`, authorization_servers: [ISSUER], scopes_supported: ['socrates.read', 'socrates.write'], bearer_methods_supported: ['header'], resource_name: 'Socrates' });
  assert.equal((await mcp('/.well-known/oauth-protected-resource/mcp')).status, 200);
  for (const p of ['/', '/api/home', '/api/session', '/media/x.png', '/index.html']) assert.equal((await mcp(p)).status, 404, p);
  assert.equal((await mcp('/mcp', { headers: { host: 'socrates.example.ts.net' } })).status, 403, 'UI host refused');
  assert.equal((await mcp('/health/live', { headers: { host: '10.42.0.17:8081', 'x-forwarded-proto': '' } })).status, 200);

  const call = (tok: string, extra: Record<string, string> = {}, body = rpc('tools/list')) => mcp('/mcp', { method: 'POST', body, headers: { ...mcpHeaders(tok), ...extra } });
  const unauth = await mcp('/mcp', { method: 'POST', body: rpc('tools/list'), headers: { 'content-type': 'application/json' } });
  assert.equal(unauth.status, 401);
  assert.equal(unauth.headers.get('www-authenticate'), `Bearer resource_metadata="${MCP}/.well-known/oauth-protected-resource", scope="socrates.read socrates.write"`);
  assert.equal(unauth.headers.get('cache-control'), 'no-store');

  const other = await generateKeyPair('ES256');
  const bad: [string, string][] = [
    ['wrong audience', await token({ aud: 'https://canvas-mcp.example.com/mcp' })],
    ['wrong issuer', await token({ iss: 'https://evil.example.com/' })],
    ['id token typ', await token({}, { typ: 'JWT' })],
    ['other key', await token({}, { key: other.privateKey })],
    ['expired beyond skew', await token({}, { exp: Math.floor(Date.now() / 1000) - 120 })],
    ['other subject', await token({ sub: 'someone-else' })],
    ['client credentials', await token({ gty: 'client_credentials' })],
    ['client subject', await token({ sub: `${OWNER_SUB}@clients` })],
  ];
  for (const [why, t] of bad) assert.equal((await call(t)).status, 401, why);
  // alg=none / HS256 confusion
  const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'at+jwt' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: ISSUER, aud: `${MCP}/mcp`, sub: OWNER_SUB, exp: 9e9, iat: 1 })).toString('base64url')}.`;
  assert.equal((await call(none)).status, 401, 'alg none');
  assert.equal((await call(await token({}), { origin: 'https://evil.example.com' })).status, 403, 'bad Origin');
  assert.equal((await call(await token({ scope: 'openid offline_access' }))).status, 403, 'no Socrates scope');

  const ok = await call(await token({}), { origin: 'https://claude.ai' });
  assert.equal(ok.status, 200);
  const all = (await ok.json()).result.tools.map((t: any) => t.name);
  assert.ok(all.includes('add_questions') && all.includes('get_tag_tree'));

  // Read-only token: write tools are not offered, and calling one fails.
  const ro = await token({ scope: 'socrates.read' });
  const roTools = (await (await call(ro)).json()).result.tools.map((t: any) => t.name);
  assert.ok(roTools.includes('get_tag_tree'));
  assert.ok(!roTools.includes('add_questions') && !roTools.includes('create_tags') && !roTools.includes('submit_grades'));
  const denied = await (await call(ro, {}, rpc('tools/call', { name: 'create_tags', arguments: { paths: ['math'] } }))).json();
  assert.ok(denied.error || denied.result?.isError, 'write tool refused for read-only token');
  const read = await (await call(ro, {}, rpc('tools/call', { name: 'get_tag_tree', arguments: {} }))).json();
  assert.ok(!read.result.isError);

  const big = await mcp('/mcp', { method: 'POST', body: 'x'.repeat(1024 * 1024 + 10), headers: mcpHeaders(await token({})) });
  assert.equal(big.status, 413);
});

test('JWKS file must hold a public P-256 key', () => {
  const f = join(dir, 'bad.json');
  writeFileSync(f, JSON.stringify({ keys: [{ kty: 'RSA', n: 'x', e: 'AQAB' }] }));
  assert.throws(() => loadJwks(f), /ES256/);
  writeFileSync(f, JSON.stringify({ keys: [{ ...jwk, d: 'secret' }] }));
  assert.throws(() => loadJwks(f), /private key|ES256/);
  assert.equal(loadJwks(jwksFile).keys.length, 1);
});

test('local mode: unchanged; localhost only, no login, /mcp with the local token', async () => {
  const app = new App(':memory:');
  const { ui, mcp } = createServers(app, loadConfig({}), { owner: null, verifyToken: null });
  assert.equal(mcp, null);
  const get = (path: string, headers: Record<string, string> = {}) => ui.request(`http://localhost:4321${path}`, { headers: { host: 'localhost:4321', ...headers } }, { remoteAddress: '127.0.0.1' });
  assert.equal((await get('/api/home')).status, 200);
  assert.equal((await get('/api/home', { host: 'socrates.example.ts.net' })).status, 403);
  assert.equal((await get('/mcp')).status, 401);
  const tok = app.mcpToken();
  const r = await ui.request('http://localhost:4321/mcp', { method: 'POST', body: rpc('tools/list'), headers: { host: 'localhost:4321', ...mcpHeaders(tok) } }, { remoteAddress: '127.0.0.1' });
  assert.equal(r.status, 200);
});

test('Orbit Hub: delegated tokens (act) work and are audited as the Hub; the Hub audience is refused', async () => {
  const { app, mcp } = deployed();
  app.tags.create('physics > optics');
  const call = (tok: string, body: string) => mcp('/mcp', { method: 'POST', body, headers: mcpHeaders(tok) });
  // RFC 8693 exchange result: our audience, owner subject, the Hub named in `act`, a subset of our scopes.
  const delegated = await token({ act: { sub: 'https://hub.example.com/client' }, scope: 'socrates.read socrates.write' });
  const r = await call(delegated, rpc('tools/call', { name: 'add_questions', arguments: { items: [{ type: 'true_false', prompt: 'Light bends when it enters glass', correct: true, tags: ['physics > optics'] }] } }));
  assert.equal(r.status, 200);
  const res = await r.json();
  assert.ok(!res.result.isError, JSON.stringify(res));
  const actor = (app.db.prepare('SELECT actor FROM audit_log ORDER BY id DESC LIMIT 1').get() as { actor: string }).actor;
  assert.match(actor, /^agent:hub\//, 'Agent activity shows the change came through the Hub');
  // A token minted for the Hub itself must never be accepted here.
  assert.equal((await call(await token({ aud: 'https://hub.example.com/mcp' }), rpc('tools/list'))).status, 401);
  assert.equal((await call(await token({ aud: ['https://hub.example.com/mcp'] }), rpc('tools/list'))).status, 401);
});
