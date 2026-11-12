import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { DATA_DIR } from './db.ts';

export const mediaDir = () => process.env.SOCRATES_MEDIA ?? join(DATA_DIR, 'media');
export const MAX_BYTES = 5 * 1024 * 1024;

/** Raster formats only. SVG is refused: it can carry scripts. */
const SIGNATURES: { ext: string; mime: string; test: (b: Uint8Array) => boolean }[] = [
  { ext: 'png', mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', mime: 'image/gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  { ext: 'webp', mime: 'image/webp', test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 },
  { ext: 'avif', mime: 'image/avif', test: (b) => String.fromCharCode(...b.slice(4, 12)) === 'ftypavif' },
];

export const mimeFor = (file: string) => SIGNATURES.find((s) => file.endsWith('.' + s.ext))?.mime;

/** Store an image under its content hash (same image = same file). Returns its URL path. */
export function saveImage(bytes: Uint8Array): { url: string; bytes: number; type: string } {
  if (bytes.length === 0) throw new Error('Empty file.');
  if (bytes.length > MAX_BYTES) throw new Error(`Image too large (${(bytes.length / 1e6).toFixed(1)} MB, max 5 MB).`);
  const sig = SIGNATURES.find((s) => s.test(bytes));
  if (!sig) throw new Error('Unsupported image. Use PNG, JPEG, GIF, WebP or AVIF.');
  const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${sig.ext}`;
  mkdirSync(mediaDir(), { recursive: true });
  const path = join(mediaDir(), name);
  if (!existsSync(path)) writeFileSync(path, bytes);
  return { url: `/media/${name}`, bytes: bytes.length, type: sig.mime };
}

export function decodeBase64(data: string): Uint8Array {
  const raw = data.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=_-]*$/.test(raw)) throw new Error('data is not valid base64.');
  return new Uint8Array(Buffer.from(raw, 'base64'));
}

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return privateAddress(v.slice(7));
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Download a public https image. Refuses private/loopback hosts and non-image content. */
export async function fetchImage(url: string): Promise<Uint8Array> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('Invalid URL.'); }
  if (u.protocol !== 'https:') throw new Error('Only https URLs are allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addrs.some(privateAddress) || /^localhost$|\.local$|\.internal$/i.test(host)) throw new Error('Refusing to fetch from a private or local address.');
  const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}.`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) throw new Error('Image too large (max 5 MB).');
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf;
}
