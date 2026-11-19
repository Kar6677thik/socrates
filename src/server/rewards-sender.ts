// Ships the reward_events outbox to Hey Ann (orbit-cloud docs/17 §7, Hub M4).
//
// One event per request, oldest first, one in flight: POST application/jose with a compact JWS signed by Socrates'
// own ES256 key. A fresh token is signed on every attempt (5-minute expiry), always over the event exactly as
// stored, with jti = event_id, so a retry after a lost 200 is a duplicate Hey Ann recognises and never pays twice.
// delivered_at is stamped only on 200. Anything else backs off exponentially (30 s doubling, capped at 1 h, with
// jitter) and keeps trying forever, so events flow again once a fix ships. Logs carry event ids and statuses only.
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { SignJWT, calculateJwkThumbprint } from 'jose';
import type { DB } from '../core/db.ts';
import { readBounded } from './owner.ts';

export const SENDER = {
  issuer: 'socrates',
  audience: 'heyann-rewards',
  typ: 'reward+jwt',
  ttlSeconds: 300,
  timeoutMs: 10_000,
  backoffBaseMs: 30_000,
  backoffMaxMs: 3600_000,
  /** How often to look for new events while idle (the reward tick also pokes the sender). */
  idlePollMs: 60_000,
} as const;

export interface SigningKey {
  key: KeyObject;
  kid: string;
}

/** Load the PKCS#8 P-256 private key; kid is the RFC 7638 thumbprint of its public half. */
export async function loadSigningKey(pem: string): Promise<SigningKey> {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new Error('The rewards signing key is not a valid PEM private key.');
  }
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType !== 'ec' || details?.namedCurve !== 'prime256v1') throw new Error('The rewards signing key must be an EC P-256 key (ES256).');
  const jwk = createPublicKey(key).export({ format: 'jwk' }) as { kty: string; crv: string; x: string; y: string };
  const kid = await calculateJwkThumbprint({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, 'sha256');
  return { key, kid };
}

export function loadSigningKeyFile(path: string): Promise<SigningKey> {
  return loadSigningKey(readBounded(path, 100, 8192, 'The rewards signing key file is missing or invalid.'));
}

/** The compact JWS for one event. `event` is the stored payload, unchanged. */
export async function signEvent(k: SigningKey, eventId: string, event: unknown, nowMs: number): Promise<string> {
  const iat = Math.floor(nowMs / 1000);
  return new SignJWT({ event: event as Record<string, unknown> })
    .setProtectedHeader({ alg: 'ES256', typ: SENDER.typ, kid: k.kid })
    .setIssuer(SENDER.issuer)
    .setAudience(SENDER.audience)
    .setJti(eventId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + SENDER.ttlSeconds)
    .sign(k.key);
}

/** 30 s, 60 s, 120 s, … capped at 1 h, then ±20% jitter (still never above the cap). */
export function backoffMs(failures: number, random: () => number = Math.random): number {
  const base = Math.min(SENDER.backoffMaxMs, SENDER.backoffBaseMs * 2 ** Math.max(0, failures - 1));
  return Math.min(SENDER.backoffMaxMs, Math.round(base * (0.8 + 0.4 * random())));
}

type Outcome = { event_id: string; status: number | 'timeout' | 'error'; delivered: boolean } | null;

export class RewardSender {
  private failures = 0;
  private nextAt = 0;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private db: DB;
  private url: string;
  private key: SigningKey;
  private fetch: typeof fetch;
  private now: () => number;
  private log: (line: string) => void;
  private random: () => number;

  constructor(opts: {
    db: DB; url: string; key: SigningKey;
    fetch?: typeof fetch; now?: () => number; log?: (line: string) => void; random?: () => number;
  }) {
    this.db = opts.db;
    this.url = opts.url;
    this.key = opts.key;
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((l) => console.log(l));
    this.random = opts.random ?? Math.random;
  }

  /** The oldest undelivered event (baseline rows are stored as delivered and never sent). */
  private next(): { event_id: string; payload: string } | undefined {
    return this.db
      .prepare('SELECT event_id, payload FROM reward_events WHERE delivered_at IS NULL ORDER BY created_at, rowid LIMIT 1')
      .get() as { event_id: string; payload: string } | undefined;
  }

  pending(): number {
    return (this.db.prepare('SELECT COUNT(*) n FROM reward_events WHERE delivered_at IS NULL').get() as { n: number }).n;
  }

  /** Earliest time the next attempt may run (0 = now). */
  get retryAt() {
    return this.nextAt;
  }

  /** Try to deliver the oldest event once, unless still backing off. */
  async attempt(): Promise<Outcome> {
    if (this.busy || this.now() < this.nextAt) return null;
    const row = this.next();
    if (!row) return null;
    this.busy = true;
    let status: number | 'timeout' | 'error';
    try {
      const jws = await signEvent(this.key, row.event_id, JSON.parse(row.payload), this.now());
      try {
        const res = await this.fetch(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/jose' },
          body: jws,
          signal: AbortSignal.timeout(SENDER.timeoutMs),
          redirect: 'error',
        });
        status = res.status;
        await res.body?.cancel().catch(() => {});
      } catch (e: any) {
        status = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'error';
      }
    } finally {
      this.busy = false;
    }
    if (status === 200) {
      this.db.prepare('UPDATE reward_events SET delivered_at = ? WHERE event_id = ? AND delivered_at IS NULL').run(this.now(), row.event_id);
      this.failures = 0;
      this.nextAt = 0;
      this.log(`[socrates] reward ${row.event_id} delivered (200)`);
      return { event_id: row.event_id, status, delivered: true };
    }
    this.failures++;
    const wait = backoffMs(this.failures, this.random);
    this.nextAt = this.now() + wait;
    this.log(`[socrates] reward ${row.event_id} not delivered (${status}); retry in ${Math.round(wait / 1000)} s`);
    return { event_id: row.event_id, status, delivered: false };
  }

  /** Send everything that's due, oldest first, until the outbox is empty or a send fails. */
  async drain(): Promise<number> {
    let sent = 0;
    for (;;) {
      const r = await this.attempt();
      if (!r || !r.delivered) return sent;
      sent++;
    }
  }

  /** Background loop: drain now, then whenever backoff ends or new events may exist. */
  start() {
    const loop = async () => {
      this.timer = null;
      if (this.stopped) return;
      try {
        await this.drain();
      } catch (e: any) {
        this.log(`[socrates] reward sender error: ${String(e?.message ?? e).slice(0, 200)}`);
      }
      if (this.stopped) return;
      const wait = this.nextAt > this.now() ? this.nextAt - this.now() : SENDER.idlePollMs;
      this.timer = setTimeout(loop, wait);
      this.timer.unref?.();
    };
    void loop();
  }

  /** New events were recorded: send soon, unless backing off. */
  poke() {
    if (this.stopped || this.busy || this.now() < this.nextAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.start(), 0);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
