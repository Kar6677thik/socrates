import { Worker } from 'node:worker_threads';

/**
 * Runs a JavaScript answer against test cases in a worker thread, inside a fresh VM context
 * (no require, process, fs or network), with a per-test timeout, a hard kill and a memory cap.
 * This guards against mistakes like infinite loops, not against hostile code: it only ever runs
 * code you typed into your own app.
 */

export interface TestCase { args: unknown[]; expected: unknown; hidden?: boolean }
export interface TestResult { pass: boolean; hidden?: boolean; args?: unknown[]; expected?: unknown; actual?: string; error?: string; ms: number }
export interface RunResult { results: TestResult[]; passed: number; total: number; error?: string; logs: string[] }

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const { code, fn, tests } = workerData;
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
parentPort.postMessage({ results, logs, error: setupError });
`;

export function runJs(code: string, tests: TestCase[], fn = 'solution'): Promise<RunResult> {
  if (!/^[A-Za-z_$][\w$]*$/.test(fn)) return Promise.resolve({ results: [], passed: 0, total: tests.length, error: 'Invalid function name', logs: [] });
  return new Promise((resolve) => {
    const w = new Worker(WORKER, {
      eval: true,
      workerData: { code, fn, tests: tests.map((t) => ({ args: t.args, expected: t.expected, hidden: !!t.hidden })) },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    });
    const done = (r: RunResult) => { clearTimeout(kill); w.terminate(); resolve(r); };
    const kill = setTimeout(() => done({ results: tests.map((t) => ({ pass: false, hidden: t.hidden, error: 'Timed out', ms: 5000 })), passed: 0, total: tests.length, error: 'Timed out after 5 s', logs: [] }), 5000);
    w.once('message', (m: { results: TestResult[]; logs: string[]; error: string | null }) => {
      const results = m.results.map((r, i) => (tests[i].hidden ? { ...r } : { ...r, args: tests[i].args, expected: tests[i].expected }));
      done({ results, passed: results.filter((r) => r.pass).length, total: results.length, error: m.error ?? undefined, logs: m.logs });
    });
    w.once('error', (e: Error) => done({ results: [], passed: 0, total: tests.length, error: e.message, logs: [] }));
  });
}

/** Hide details of hidden tests before sending results to the UI. */
export function redact(r: RunResult): RunResult {
  return { ...r, results: r.results.map((x) => (x.hidden ? { pass: x.pass, hidden: true, ms: x.ms, error: x.error ? 'failed' : undefined } : x)) };
}
