// Create the owner login files for a deployed Socrates: <dir>/verifier (password hash, Identity V3 format) and
// <dir>/totp (base32 authenticator secret). Same formats as orbit-cloud's Orbit.Credentials, which also works.
//   node --no-warnings scripts/credentials.ts <output-dir>
// The password is read from stdin (pipe it, or type it and press Enter; it is not echoed when stdin is a terminal).
// Use a password that is unique to Socrates. Never commit the output; it goes into a Kubernetes Secret.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { makeVerifier, toBase32 } from '../src/server/owner.ts';

const out = process.argv[2];
if (!out) {
  console.error('Usage: node --no-warnings scripts/credentials.ts <output-dir>');
  process.exit(2);
}
const dir = resolve(out);
if (existsSync(join(dir, 'verifier')) || existsSync(join(dir, 'totp'))) {
  console.error(`${dir} already has credential files; refusing to overwrite them.`);
  process.exit(1);
}

async function readPassword(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let s = '';
    for await (const chunk of stdin) s += chunk;
    return s.replace(/\r?\n$/, '');
  }
  process.stderr.write('Password (not shown): ');
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  return new Promise((done) => {
    let s = '';
    stdin.on('data', (k: string) => {
      for (const ch of k) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write('\n');
          return done(s);
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1);
        else s += ch;
      }
    });
  });
}

const password = await readPassword();
if (password.length < 12) {
  console.error('Use at least 12 characters.');
  process.exit(1);
}
const secret = toBase32(randomBytes(20));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'verifier'), await makeVerifier(password), { mode: 0o600 });
writeFileSync(join(dir, 'totp'), secret, { mode: 0o600 });
console.log(`Wrote ${join(dir, 'verifier')} and ${join(dir, 'totp')}.`);
console.log('Add this to your authenticator app (or enter the secret by hand: TOTP, SHA-1, 6 digits, 30 s):');
console.log(`  otpauth://totp/Socrates:owner?secret=${secret}&issuer=Socrates&algorithm=SHA1&digits=6&period=30`);
console.log(`  secret: ${secret}`);
