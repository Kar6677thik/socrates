// Owner login for the UI listener: password + TOTP, in the same file formats as Orbit and Sprawl
// (orbit-cloud Orbit.Credentials writes both), and an in-memory session behind a __Host- cookie.
import { openSync, readSync, closeSync } from 'node:fs';
import { createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);

/**
 * Read a small secret file. Kubernetes Secret keys are symlinks, so bound what the opened file yields rather than
 * trusting a stat of the path.
 */
export function readBounded(path: string, min: number, max: number, error: string): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (let r; n < buf.length && (r = readSync(fd, buf, n, buf.length - n, null)) > 0;) n += r;
    if (n < min || n > max) throw new Error(error);
    return buf.subarray(0, n).toString('utf8').trim();
  } catch (e: any) {
    throw new Error(e.message === error ? error : `${error} (${e.code ?? e.message})`);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// ---- Password: ASP.NET Core Identity V3 hash (0x01 | prf u32 | iterations u32 | salt length u32 | salt | subkey)

const PRF: Record<number, string> = { 0: 'sha1', 1: 'sha256', 2: 'sha512' };

export interface Verifier { digest: string; iterations: number; salt: Buffer; subkey: Buffer }

export function parseVerifier(text: string): Verifier {
  let b: Buffer;
  try {
    b = Buffer.from(text, 'base64');
  } catch {
    throw new Error('Owner verifier format is invalid.');
  }
  if (b.length < 13 || b[0] !== 1) throw new Error('Owner verifier must use the Identity V3 format.');
  const prf = b.readUInt32BE(1), iterations = b.readUInt32BE(5), saltLen = b.readUInt32BE(9);
  if (!(prf in PRF) || iterations < 100_000 || iterations > 1_000_000 || saltLen < 16 || saltLen > 128 || b.length < 13 + saltLen + 32)
    throw new Error('Owner verifier must use the Identity V3 format and a bounded work factor.');
  return { digest: PRF[prf], iterations, salt: b.subarray(13, 13 + saltLen), subkey: b.subarray(13 + saltLen) };
}

export async function verifyPassword(v: Verifier, password: string): Promise<boolean> {
  const derived = await pbkdf2Async(Buffer.from(password, 'utf8'), v.salt, v.iterations, v.subkey.length, v.digest);
  return timingSafeEqual(derived, v.subkey);
}

/** Make a verifier in the same format (PBKDF2-HMAC-SHA512, 600k iterations, 16-byte salt, 32-byte subkey). */
export async function makeVerifier(password: string, iterations = 600_000): Promise<string> {
  const salt = randomBytes(16);
  const subkey = await pbkdf2Async(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha512');
  const head = Buffer.alloc(13);
  head[0] = 1;
  head.writeUInt32BE(2, 1);
  head.writeUInt32BE(iterations, 5);
  head.writeUInt32BE(16, 9);
  return Buffer.concat([head, salt, subkey]).toString('base64');
}

// ---- TOTP: RFC 6238, HMAC-SHA1, 30 s, 6 digits, ±1 step

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function fromBase32(text: string): Buffer {
  const out: number[] = [];
  let buffer = 0, bits = 0;
  for (const ch of text.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32 character.');
    buffer = ((buffer << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function toBase32(data: Buffer): string {
  let out = '', buffer = 0, bits = 0;
  for (const byte of data) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
  return out;
}

export function totpCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(counter).digest();
  const o = h[h.length - 1] & 0x0f;
  const v = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(v % 1_000_000).padStart(6, '0');
}

export const totpStep = (ms: number) => Math.floor(ms / 1000 / 30);

/** The matching step within one step of skew, or null. Constant-time per comparison. */
export function totpMatch(secret: Buffer, code: string, nowMs: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  let matched: number | null = null;
  const cur = totpStep(nowMs);
  for (let s = cur - 1; s <= cur + 1; s++) if (timingSafeEqual(Buffer.from(totpCode(secret, s)), Buffer.from(code))) matched ??= s;
  return matched;
}

// ---- The owner

export const SESSION_COOKIE = '__Host-socrates_session';
const IDLE_MS = 30 * 60_000;
const ABSOLUTE_MS = 12 * 3600_000;
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

export type LoginResult = { ok: true; session: string } | { ok: false; status: 401 | 429 | 503; error: string };

export class Owner {
  private verifier: Verifier;
  private totp: Buffer;
  private lastStep = -Infinity;
  private failures: number[] = [];
  private hashing = 0;
  private sessions = new Map<string, { created: number; seen: number }>();
  private now: () => number;

  constructor(opts: { verifier: string; totp: string; now?: () => number }) {
    this.verifier = parseVerifier(opts.verifier);
    this.totp = fromBase32(opts.totp);
    if (this.totp.length < 20) throw new Error('Owner TOTP secret must be at least 160 bits.');
    this.now = opts.now ?? Date.now;
  }

  static fromFiles(credentialFile: string, totpFile: string): Owner {
    return new Owner({
      verifier: readBounded(credentialFile, 20, 1024, 'Owner verifier file is missing or invalid.'),
      totp: readBounded(totpFile, 16, 128, 'Owner TOTP file is missing or invalid.'),
    });
  }

  private locked(): boolean {
    const cutoff = this.now() - FAIL_WINDOW_MS;
    this.failures = this.failures.filter((t) => t >= cutoff);
    return this.failures.length >= MAX_FAILURES;
  }

  async login(password: unknown, code: unknown): Promise<LoginResult> {
    if (this.locked()) return { ok: false, status: 429, error: 'Too many failed sign-ins. Wait 15 minutes.' };
    if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 1024 || typeof code !== 'string') {
      this.failures.push(this.now());
      return { ok: false, status: 401, error: 'Sign-in failed.' };
    }
    if (this.hashing >= 2) return { ok: false, status: 429, error: 'Please wait before signing in again.' };
    this.hashing++;
    let passwordOk: boolean;
    try {
      passwordOk = await verifyPassword(this.verifier, password);
    } finally {
      this.hashing--;
    }
    // The code is consumed only after the password matches, so wrong-password guesses can't burn it. Each step is single-use.
    let ok = false;
    if (passwordOk) {
      const step = totpMatch(this.totp, code.trim(), this.now());
      if (step !== null && step > this.lastStep) {
        this.lastStep = step;
        ok = true;
      }
    }
    if (!ok) {
      this.failures.push(this.now());
      return { ok: false, status: 401, error: 'Sign-in failed.' };
    }
    this.failures = [];
    const session = randomBytes(32).toString('base64url');
    const t = this.now();
    this.sessions.set(session, { created: t, seen: t });
    return { ok: true, session };
  }

  /** True for a live session; refreshes its idle timer. */
  check(session: string | undefined): boolean {
    if (!session) return false;
    const s = this.sessions.get(session);
    if (!s) return false;
    const t = this.now();
    if (t - s.seen > IDLE_MS || t - s.created > ABSOLUTE_MS) {
      this.sessions.delete(session);
      return false;
    }
    s.seen = t;
    return true;
  }

  logout(session: string | undefined) {
    if (session) this.sessions.delete(session);
  }
}
