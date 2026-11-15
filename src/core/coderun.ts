import { spawn } from 'node:child_process';

/**
 * Runs a JavaScript answer against test cases in a separate Node process.
 *
 * The VM context only keeps honest code tidy (no `require` or `process` in scope); it is not a
 * security boundary, since one line escapes it. The boundary is the child process:
 * - Node's permission model with nothing granted: no file reads or writes, no child processes,
 *   no workers, no native addons;
 * - an empty environment, so none of the server's settings or secrets;
 * - a 64 MB heap, a per-test timeout and a hard kill after 5 s;
 * - at most two runs at a time.
 * Network access is not covered by the permission model before Node 25, so deployments must also
 * block egress (the Kubernetes NetworkPolicy does).
 * Code can reach this runner from an AI agent over MCP, so treat it as hostile.
 */

export interface TestCase { args: unknown[]; expected: unknown; hidden?: boolean }
export interface TestResult { pass: boolean; hidden?: boolean; args?: unknown[]; expected?: unknown; actual?: string; error?: string; ms: number }
export interface RunResult { results: TestResult[]; passed: number; total: number; error?: string; logs: string[] }

const WORKER = `
const vm = require('node:vm');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
const { code, fn, tests } = JSON.parse(input);
const logs = [];
const fmt = (v) => {
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  try { return typeof v === 'string' ? JSON.stringify(v) : v === undefined ? 'undefined' : JSON.stringify(v, (k, x) => typeof x === 'bigint' ? x.toString() + 'n' : typeof x === 'number' && !Number.isFinite(x) ? String(x) : x); } catch { return String(v); }
};
// JSON would turn Infinity, NaN and undefined into null; keep them distinct so they can't pass as null.
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '__num:' + String(v);
    if (!Number.isInteger(v)) return Math.round(v * 1e9) / 1e9;
  }
  if (v === undefined) return '__undefined';
  if (typeof v === 'bigint') return '__bigint:' + v.toString();
  return v;
};
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const ctx = vm.createContext({ console: { log: (...a) => { if (logs.length < 50) logs.push(a.map((x) => typeof x === 'string' ? x : fmt(x)).join(' ').slice(0, 500)); } } });
let setupError = null;
try { vm.runInContext(code + '\\n;globalThis.__fn = typeof ' + fn + ' === "function" ? ' + fn + ' : undefined;', ctx, { timeout: 1000 }); }
catch (e) { setupError = String(e && e.message || e); }
if (!setupError && typeof ctx.__fn !== 'function') setupError = 'Define a function named ' + fn + '.';
const results = tests.map((t) => {
  if (setupError) return { pass: false, hidden: t.hidden, error: setupError, ms: 0 };
  ctx.__args = JSON.parse(JSON.stringify(t.args));
  const start = performance.now();
  try {
    const out = vm.runInContext('__fn(...__args)', ctx, { timeout: 1000 });
    const ms = Math.round(performance.now() - start);
    return { pass: same(out, t.expected), hidden: t.hidden, actual: fmt(out).slice(0, 300), ms };
  } catch (e) {
    return { pass: false, hidden: t.hidden, error: String(e && e.message || e).slice(0, 300), ms: Math.round(performance.now() - start) };
  }
});
process.stdout.write(JSON.stringify({ results, logs, error: setupError }));
});
`;

const MAX_PARALLEL = 2;
const MAX_OUTPUT = 4 * 1024 * 1024;
let running = 0;
const waiting: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export function runJs(code: string, tests: TestCase[], fn = 'solution'): Promise<RunResult> {
  if (!Array.isArray(tests) || tests.length > 200) return Promise.resolve({ results: [], passed: 0, total: 0, error: 'Too many tests (200 at most)', logs: [] });
  if (code.length > 100_000) return Promise.resolve({ results: [], passed: 0, total: tests.length, error: 'Code is too long (100 KB at most)', logs: [] });
  if (!/^[A-Za-z_$][\w$]*$/.test(fn)) return Promise.resolve({ results: [], passed: 0, total: tests.length, error: 'Invalid function name', logs: [] });
  const input = JSON.stringify({ code, fn, tests: tests.map((t) => ({ args: t.args, expected: t.expected, hidden: !!t.hidden })) });
  return slot(() => new Promise<RunResult>((resolve) => {
    const fail = (error: string): RunResult => ({ results: tests.map((t) => ({ pass: false, hidden: t.hidden, error, ms: 0 })), passed: 0, total: tests.length, error, logs: [] });
    // --permission with no --allow-* flags: no fs, child processes, workers, addons or WASI.
    const child = spawn(process.execPath, ['--permission', '--max-old-space-size=64', '--stack-size=984', '-e', WORKER], {
      env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '', err = '', settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(kill);
      child.kill('SIGKILL');
      resolve(r);
    };
    const kill = setTimeout(() => done({ ...fail('Timed out'), error: 'Timed out after 5 s' }), 5000);
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      out += d;
      if (out.length > MAX_OUTPUT) done(fail('Output too large'));
    });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { if (err.length < 4000) err += d; });
    child.on('error', (e) => done(fail(e.message)));
    child.on('close', (status) => {
      let m: { results: TestResult[]; logs: string[]; error: string | null };
      try {
        m = JSON.parse(out);
        if (!Array.isArray(m.results) || m.results.length !== tests.length) throw new Error('bad output');
      } catch {
        const oom = /heap out of memory|Allocation failed/i.test(err);
        return done(fail(oom ? 'Out of memory' : `The code runner stopped unexpectedly (exit ${status}).`));
      }
      const results = m.results.map((r, i) => {
        const clean: TestResult = { pass: r.pass === true, hidden: tests[i].hidden, ms: Number(r.ms) || 0 };
        if (r.actual !== undefined) clean.actual = String(r.actual).slice(0, 300);
        if (r.error !== undefined) clean.error = String(r.error).slice(0, 300);
        return tests[i].hidden ? clean : { ...clean, args: tests[i].args, expected: tests[i].expected };
      });
      const logs = Array.isArray(m.logs) ? m.logs.slice(0, 50).map((l) => String(l).slice(0, 500)) : [];
      done({ results, passed: results.filter((r) => r.pass).length, total: results.length, error: m.error ? String(m.error) : undefined, logs });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  }));
}

/** Hide details of hidden tests before sending results to the UI. */
export function redact(r: RunResult): RunResult {
  return { ...r, results: r.results.map((x) => (x.hidden ? { pass: x.pass, hidden: true, ms: x.ms, error: x.error ? 'failed' : undefined } : x)) };
}
