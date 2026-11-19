// Hub M4: the reward_events outbox shipped to Hey Ann as signed JWS, one at a time, oldest first, delivered on 200.
process.env.SOCRATES_EMBEDDINGS ??= 'off';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { jwtVerify, decodeProtectedHeader, calculateJwkThumbprint, importJWK } from 'jose';
import { App } from '../src/core/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { RewardSender, loadSigningKey, backoffMs, SENDER } from '../src/server/rewards-sender.ts';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' }) as any;
const URL_ = 'http://10.43.0.106:8082/internal/rewards';

function setup(responses: (number | 'timeout' | 'error')[]) {
  const app = new App(':memory:');
  let clock = Date.UTC(2026, 10, 19, 6, 0, 0);
  const insert = (id: string, createdAt: number, payload: Record<string, unknown>) =>
    app.db.prepare('INSERT INTO reward_events(event_id, kind, day, occurred_at, payload, created_at, delivered_at) VALUES(?,?,?,?,?,?,NULL)')
      .run(id, String(payload.kind), '2026-11-19', createdAt, JSON.stringify(payload), createdAt);
  const requests: { url: string; init: RequestInit; jws: string; at: number }[] = [];
  const queue = [...responses];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, init, jws: String(init.body), at: clock });
    const r = queue.shift() ?? 200;
    if (r === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    if (r === 'error') throw new TypeError('fetch failed');
    return new Response(r === 200 ? '{"status":"applied"}' : '{"error":"nope"}', { status: r });
  }) as unknown as typeof fetch;
  const logs: string[] = [];
  return {
    app, insert, requests, logs,
    tick: (ms: number) => { clock += ms; },
    now: () => clock,
    sender: async () => new RewardSender({ db: app.db, url: URL_, key: await loadSigningKey(PEM), fetch: fakeFetch, now: () => clock, log: (l) => logs.push(l), random: () => 0.5 }),
    delivered: (id: string) => (app.db.prepare('SELECT delivered_at FROM reward_events WHERE event_id = ?').get(id) as { delivered_at: number | null }).delivered_at,
  };
}

const STUDY = { event_id: 'socrates:study:7', kind: 'study_minutes', day: '2026-11-19', occurred_at: 1, minutes: 6.5, intervals: [[1, 2]], session_id: 7, attempts_credited: 3, pending: 0 };

test('kid is the RFC 7638 thumbprint; bad keys are refused', async () => {
  const k = await loadSigningKey(PEM);
  assert.equal(k.kid, await calculateJwkThumbprint({ kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y }, 'sha256'));
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  await assert.rejects(loadSigningKey(rsa), /P-256/);
  const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  await assert.rejects(loadSigningKey(p384), /P-256/);
  await assert.rejects(loadSigningKey('not a key'), /PEM/);
});

test('each request is one compact JWS with the agreed header and claims, over the stored event unchanged', async () => {
  const t = setup([200]);
  t.insert(STUDY.event_id, 1000, STUDY);
  const s = await t.sender();
  const r = await s.attempt();
  assert.deepEqual(r, { event_id: STUDY.event_id, status: 200, delivered: true });
  const [req] = t.requests;
  assert.equal(req.url, URL_);
  assert.equal(req.init.method, 'POST');
  assert.equal((req.init.headers as Record<string, string>)['Content-Type'], 'application/jose');
  assert.match(req.jws, /^[\w-]+\.[\w-]+\.[\w-]+$/, 'compact JWS');
  const header = decodeProtectedHeader(req.jws);
  assert.deepEqual(header, { alg: 'ES256', typ: 'reward+jwt', kid: (await loadSigningKey(PEM)).kid });
  const { payload } = await jwtVerify(req.jws, await importJWK({ kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y }, 'ES256'), {
    issuer: 'socrates', audience: 'heyann-rewards', typ: 'reward+jwt', currentDate: new Date(req.at),
  });
  assert.equal(payload.jti, STUDY.event_id);
  assert.equal(payload.iat, Math.floor(req.at / 1000));
  assert.equal(payload.exp, payload.iat! + 300);
  assert.deepEqual(payload.event, STUDY, 'the outbox payload exactly as stored');
  assert.ok(t.delivered(STUDY.event_id));
});

test('delivered only on 200; 401, 422, 503, timeouts and network errors back off and retry with a fresh signature', async () => {
  const t = setup([401, 422, 503, 'timeout', 'error', 200]);
  t.insert(STUDY.event_id, 1000, STUDY);
  const s = await t.sender();
  const waits: number[] = [];
  for (let i = 0; i < 5; i++) {
    const r = await s.attempt();
    assert.equal(r!.delivered, false);
    assert.equal(t.delivered(STUDY.event_id), null, 'not delivered yet');
    assert.equal(await s.attempt(), null, 'no attempt while backing off');
    waits.push(s.retryAt - t.now());
    t.tick(s.retryAt - t.now() + 1000); // a second past the backoff
  }
  // random() = 0.5 means no jitter: 30 s doubling.
  assert.deepEqual(waits, [30_000, 60_000, 120_000, 240_000, 480_000]);
  const ok = await s.attempt();
  assert.equal(ok!.delivered, true);
  assert.ok(t.delivered(STUDY.event_id));
  assert.equal(t.requests.length, 6);
  // Same event every time (same jti and payload), but a new token each time: never an expired one.
  const tokens = new Set(t.requests.map((r) => r.jws));
  assert.equal(tokens.size, 6, 'signed afresh on every attempt');
  for (const r of t.requests) {
    const { payload } = await jwtVerify(r.jws, await importJWK({ kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y }, 'ES256'), { currentDate: new Date(r.at) });
    assert.equal(payload.jti, STUDY.event_id);
    assert.deepEqual(payload.event, STUDY);
    assert.equal(payload.iat, Math.floor(r.at / 1000));
  }
  // After success the backoff resets.
  assert.equal(s.retryAt, 0);
});

test('backoff: 30 s doubling, capped at an hour, jitter within ±20% and never above the cap', () => {
  const mid = () => 0.5;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => backoffMs(n, mid)), [30e3, 60e3, 120e3, 240e3, 480e3, 960e3, 1920e3, 3600e3, 3600e3]);
  assert.equal(backoffMs(1, () => 0), 24_000);
  assert.equal(backoffMs(1, () => 0.999999), 36_000);
  assert.equal(backoffMs(30, () => 0.999999), SENDER.backoffMaxMs);
});

test('oldest first, one at a time, and a failing event holds the queue until it gets through', async () => {
  const t = setup([200, 503, 200, 200]);
  t.insert('socrates:study:3', 3000, { ...STUDY, event_id: 'socrates:study:3' });
  t.insert('socrates:mastery:9:70', 1000, { event_id: 'socrates:mastery:9:70', kind: 'mastery_up' });
  t.insert('socrates:study:2', 2000, { ...STUDY, event_id: 'socrates:study:2' });
  // Baseline rows are stored as delivered and must never be sent.
  t.app.db.prepare("INSERT INTO reward_events(event_id, kind, day, occurred_at, payload, created_at, delivered_at) VALUES('socrates:mastery:1:50','mastery_up','2026-11-01',1,'{\"baseline\":true}',500,500)").run();
  const s = await t.sender();
  assert.equal(await s.drain(), 1, 'first event sent, then a 503 stops the run');
  t.tick(31_000);
  assert.equal(await s.drain(), 2);
  const jtis = await Promise.all(t.requests.map(async (r) => (await jwtVerify(r.jws, await importJWK({ kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y }, 'ES256'), { currentDate: new Date(r.at) })).payload.jti));
  assert.deepEqual(jtis, ['socrates:mastery:9:70', 'socrates:study:2', 'socrates:study:2', 'socrates:study:3']);
  assert.equal(s.pending(), 0);
});

test('logs name events and statuses, never the token or the key', async () => {
  const t = setup([503, 200]);
  t.insert(STUDY.event_id, 1000, STUDY);
  const s = await t.sender();
  await s.attempt();
  t.tick(60_000);
  await s.attempt();
  const all = t.logs.join('\n');
  assert.match(all, /socrates:study:7 not delivered \(503\)/);
  assert.match(all, /socrates:study:7 delivered \(200\)/);
  for (const r of t.requests) for (const part of r.jws.split('.')) assert.ok(!all.includes(part), 'no token in logs');
  const keyBody = PEM.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  assert.ok(!all.includes(keyBody.slice(0, 40)), 'no key in logs');
  assert.ok(!all.includes(publicJwk.x), 'no key material in logs');
});

test('off unless SOCRATES_REWARDS_URL is set; the key file must come with it', () => {
  const off = loadConfig({});
  assert.equal(off.rewardsUrl, null);
  assert.equal(off.rewardsKeyFile, null);
  assert.equal(loadConfig({ SOCRATES_REWARDS_URL: URL_, SOCRATES_REWARDS_KEY_FILE: '/run/socrates/rewards/signing-key.pem' }).rewardsUrl, URL_);
  assert.throws(() => loadConfig({ SOCRATES_REWARDS_URL: URL_ }), /SOCRATES_REWARDS_KEY_FILE/);
  assert.throws(() => loadConfig({ SOCRATES_REWARDS_KEY_FILE: '/x' }), /SOCRATES_REWARDS_URL is not/);
  assert.throws(() => loadConfig({ SOCRATES_REWARDS_URL: 'ftp://x/y', SOCRATES_REWARDS_KEY_FILE: '/x' }), /http\(s\)/);
});
