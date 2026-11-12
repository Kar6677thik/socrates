import { inflateRawSync } from 'node:zlib';

/** Minimal zip reader (stored and deflate entries), enough for Anki .apkg files. */
export interface ZipEntry { name: string; size: number; read: () => Buffer }

export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

export function readZip(buf: Buffer): Map<string, ZipEntry> {
  // End of central directory: scan back over the comment (max 64 KB).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file.');
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  // Zip64: the classic fields are maxed out and a zip64 locator precedes the EOCD.
  if ((cdOffset === 0xffffffff || count === 0xffff) && eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) {
    const z64 = Number(buf.readBigUInt64LE(eocd - 12));
    count = Number(buf.readBigUInt64LE(z64 + 32));
    cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
  }
  const out = new Map<string, ZipEntry>();
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip directory.');
    const method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    let local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // zip64 extra field carries the real sizes and offset
    let e = p + 46 + nameLen;
    const end = e + extraLen;
    while (e + 4 <= end) {
      const id = buf.readUInt16LE(e), len = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (local === 0xffffffff) { local = Number(buf.readBigUInt64LE(q)); }
      }
      e += 4 + len;
    }
    p = end + commentLen;
    if (name.endsWith('/')) continue;
    const size = usize;
    out.set(name, {
      name,
      size,
      read: () => {
        if (size > MAX_ENTRY_BYTES) throw new Error(`${name} is too large to import.`);
        if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('Corrupt zip entry.');
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + csize);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return inflateRawSync(data, { maxOutputLength: Math.max(size, 1) });
        throw new Error(`Unsupported zip compression (${method}) in ${name}.`);
      },
    });
  }
  return out;
}
