// `npm start`: build the UI on first run (or when sources are newer), then serve everything on one port.
import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = join(ROOT, 'web', 'dist', 'index.html');

function newest(dir: string): number {
  let t = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : statSync(p).mtimeMs);
  }
  return t;
}

if (!existsSync(dist) || newest(join(ROOT, 'web', 'src')) > statSync(dist).mtimeMs) {
  console.log('Building UI...');
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
}
await import('./index.ts');
