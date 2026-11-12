import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { default_w, FSRS6_DEFAULT_DECAY } from 'ts-fsrs';
import { type DB, getSetting, setSetting, tx, now } from './db.ts';
import { studyDay } from './srs.ts';

/**
 * Fit FSRS-6 weights to your own review history.
 *
 * The forward pass mirrors ts-fsrs's FSRS6Algorithm (same formulas and bounds, without
 * the 8-digit rounding) so fitted weights mean the same thing to the scheduler.
 * Loss: mean log loss of predicted recall on every review at least a day after the
 * previous one, plus a pull towards the starting weights that fades as data grows.
 */

export const MIN_REVIEWS = 100;
const S_MIN = 0.001;
const S_MAX = 36500;

/** Parameter bounds, copied from ts-fsrs (FSRS6ParameterBounds with short-term on). */
const BOUNDS: [number, number][] = [
  [S_MIN, 100], [S_MIN, 100], [S_MIN, 100], [S_MIN, 100],
  [1, 10], [0.001, 4], [0.001, 4], [0.001, 0.75], [0, 4.5], [0, 0.8], [0.001, 3.5],
  [0.001, 5], [0.001, 0.25], [0.001, 0.9], [0, 4], [0, 1], [1, 6], [0, 2], [0, 2], [0.01, 0.8], [0.1, 0.8],
];

export const DEFAULT_WEIGHTS: number[] = [...default_w];

export interface Review { t: number; g: number }
export type History = Review[][];

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

export function clipWeights(w: number[]): number[] {
  return w.map((v, i) => clamp(v, BOUNDS[i][0], BOUNDS[i][1]));
}

export function validWeights(w: unknown): w is number[] {
  return Array.isArray(w) && w.length === 21 && w.every((v, i) => typeof v === 'number' && Number.isFinite(v) && v >= BOUNDS[i][0] - 1e-9 && v <= BOUNDS[i][1] + 1e-9);
}

function curve(w: number[]) {
  const decay = -w[20];
  const factor = Math.pow(0.9, 1 / decay) - 1;
  return (t: number, s: number) => Math.pow(1 + (factor * t) / s, decay);
}

/** Memory state after each review of one card, plus the predicted recall before each review. */
export function replay(w: number[], seq: Review[]): { s: number; d: number; r: (number | null)[] } {
  const R = curve(w);
  const initD = (g: number) => w[4] - Math.exp((g - 1) * w[5]) + 1;
  let s = 0, d = 0;
  const rs: (number | null)[] = [];
  for (let i = 0; i < seq.length; i++) {
    const { t, g } = seq[i];
    if (i === 0) {
      s = clamp(w[g - 1], S_MIN, S_MAX);
      d = clamp(initD(g), 1, 10);
      rs.push(null);
      continue;
    }
    const r = R(t, s);
    rs.push(t > 0 ? r : null);
    let ns: number;
    if (t === 0) {
      const sinc = Math.pow(s, -w[19]) * Math.exp(w[17] * (g - 3 + w[18]));
      ns = clamp(s * (g >= 2 ? Math.max(sinc, 1) : sinc), S_MIN, S_MAX);
    } else if (g === 1) {
      const f = clamp(w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - r) * w[14]), S_MIN, S_MAX);
      ns = clamp(s / Math.exp(w[17] * w[18]), S_MIN, f);
    } else {
      const bonus = g === 2 ? w[15] : g === 4 ? w[16] : 1;
      ns = clamp(s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp((1 - r) * w[10]) - 1) * bonus), S_MIN, S_MAX);
    }
    const nd = d + (-w[6] * (g - 3) * (10 - d)) / 9;
    d = clamp(w[7] * initD(4) + (1 - w[7]) * nd, 1, 10);
    s = ns;
  }
  return { s, d, r: rs };
}

/** Mean log loss and binned calibration error (RMSE over 20 bins of predicted recall, weighted by count). */
export function evaluate(w: number[], hist: History) {
  let loss = 0, n = 0;
  const bins = Array.from({ length: 20 }, () => ({ p: 0, y: 0, n: 0 }));
  for (const seq of hist) {
    const { r } = replay(w, seq);
    for (let i = 1; i < seq.length; i++) {
      const p = r[i];
      if (p == null) continue;
      const y = seq[i].g > 1 ? 1 : 0;
      const pc = clamp(p, 1e-4, 1 - 1e-4);
      loss -= y * Math.log(pc) + (1 - y) * Math.log(1 - pc);
      n++;
      const b = bins[Math.min(19, Math.floor(p * 20))];
      b.p += p; b.y += y; b.n++;
    }
  }
  let se = 0;
  for (const b of bins) if (b.n) se += b.n * ((b.p - b.y) / b.n) ** 2;
  return { log_loss: n ? loss / n : 0, rmse: n ? Math.sqrt(se / n) : 0, n };
}

export function countReviews(hist: History) {
  let n = 0;
  for (const seq of hist) for (let i = 1; i < seq.length; i++) if (seq[i].t > 0) n++;
  return n;
}

/**
 * Adam in normalised coordinates (each weight scaled to [0, 1] by its bounds), with
 * central-difference gradients. Cheap enough: a few thousand reviews fit in about a second.
 */
export function fit(hist: History, start: number[] = DEFAULT_WEIGHTS, iters = 250): number[] {
  const n = countReviews(hist);
  if (!n) return [...start];
  const lo = BOUNDS.map((b) => b[0]), span = BOUNDS.map((b) => b[1] - b[0]);
  const toW = (u: number[]) => u.map((x, i) => lo[i] + clamp(x, 0, 1) * span[i]);
  const u0 = start.map((v, i) => clamp((v - lo[i]) / span[i], 0, 1));
  const prior = 40 / n; // pull towards the starting weights; fades with more reviews
  const objective = (u: number[]) => {
    let reg = 0;
    for (let i = 0; i < u.length; i++) reg += (u[i] - u0[i]) ** 2;
    return evaluate(toW(u), hist).log_loss + prior * reg;
  };
  // the decay (w20) is only fitted with plenty of data; it is the least identifiable weight
  const free = BOUNDS.map((_, i) => i !== 20 || n >= 1000);
  const u = [...u0];
  const m = new Array(u.length).fill(0), v = new Array(u.length).fill(0);
  const lr = 0.02, b1 = 0.9, b2 = 0.999, h = 1e-4;
  let best = [...u], bestLoss = objective(u), stale = 0;
  for (let k = 1; k <= iters; k++) {
    const g = new Array(u.length).fill(0);
    for (let i = 0; i < u.length; i++) {
      if (!free[i]) continue;
      const a = [...u], b = [...u];
      a[i] = clamp(a[i] + h, 0, 1); b[i] = clamp(b[i] - h, 0, 1);
      g[i] = (objective(a) - objective(b)) / (a[i] - b[i] || h);
    }
    const step = lr * (k > iters * 0.7 ? 0.3 : 1);
    for (let i = 0; i < u.length; i++) {
      if (!free[i]) continue;
      m[i] = b1 * m[i] + (1 - b1) * g[i];
      v[i] = b2 * v[i] + (1 - b2) * g[i] * g[i];
      const mh = m[i] / (1 - b1 ** k), vh = v[i] / (1 - b2 ** k);
      u[i] = clamp(u[i] - (step * mh) / (Math.sqrt(vh) + 1e-8), 0, 1);
    }
    if (k % 10 === 0 || k === iters) {
      const l = objective(u);
      if (l < bestLoss - 1e-6) { bestLoss = l; best = [...u]; stale = 0; }
      else if (++stale >= 3) break; // no progress in 30 steps
    }
  }
  return clipWeights(toW(best).map((x) => Math.round(x * 1e4) / 1e4));
}

/**
 * Review sequences per card, in order. A sequence restarts when the card was new again
 * (first review, or after a major edit reset the schedule). t is whole study days since
 * the previous review, so same-day repeats are t = 0, as in FSRS.
 */
export function loadHistory(db: DB): { hist: History; ids: number[]; last: number[] } {
  const rows = db
    .prepare(`SELECT question_id AS q, answered_at AS at, rating AS g, srs_before IS NULL AS fresh
              FROM attempts WHERE rating BETWEEN 1 AND 4 ORDER BY question_id, answered_at, id`)
    .all() as { q: number; at: number; g: number; fresh: number }[];
  const hist: History = [], ids: number[] = [], last: number[] = [];
  let cur: Review[] | null = null, curQ = -1, prevDay = 0;
  const dayNum = (ts: number) => Math.round(Date.parse(studyDay(ts) + 'T00:00:00Z') / 864e5);
  for (const r of rows) {
    const day = dayNum(r.at);
    if (r.q !== curQ || r.fresh) {
      cur = [];
      hist.push(cur); ids.push(r.q); last.push(r.at);
      curQ = r.q;
      cur.push({ t: 0, g: r.g });
    } else {
      cur!.push({ t: Math.max(0, day - prevDay), g: r.g });
      last[last.length - 1] = r.at;
    }
    prevDay = day;
  }
  return { hist, ids, last };
}

/** Split cards into train and test by question id, so a card's reviews never sit on both sides. */
function split(hist: History, ids: number[]) {
  const train: History = [], test: History = [];
  hist.forEach((s, i) => ((ids[i] * 2654435761) % 5 === 0 ? test : train).push(s));
  return { train, test };
}

export function currentWeights(db: DB): number[] {
  const w = getSetting<number[] | null>(db, 'fsrs_weights', null);
  return validWeights(w) ? w : DEFAULT_WEIGHTS;
}

export interface OptimizeResult {
  reviews: number;
  cards: number;
  enough: boolean;
  current: number[];
  fitted: number[] | null;
  /** Measured on held-out cards (fitted on the rest), so it shows whether the fit generalises. */
  holdout: { current: { log_loss: number; rmse: number }; fitted: { log_loss: number; rmse: number }; n: number } | null;
  /** Measured on every review, with the weights fitted on all of them. */
  all: { current: { log_loss: number; rmse: number }; fitted: { log_loss: number; rmse: number } } | null;
  better: boolean;
}

/** Run `fit` in a worker thread so a large history doesn't block the server. */
function fitInWorker(hist: History, start: number[]): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./optimize.ts', import.meta.url), { workerData: { hist, start } });
    w.once('message', resolve);
    w.once('error', reject);
    w.once('exit', (code) => code && reject(new Error(`Optimizer stopped (${code})`)));
  });
}

if (!isMainThread && workerData?.hist) parentPort!.postMessage(fit(workerData.hist, workerData.start));

export async function optimize(db: DB, opts: { inline?: boolean } = {}): Promise<OptimizeResult> {
  const { hist, ids } = loadHistory(db);
  const reviews = countReviews(hist);
  const current = currentWeights(db);
  const base = { reviews, cards: new Set(ids).size, current };
  if (reviews < MIN_REVIEWS) return { ...base, enough: false, fitted: null, holdout: null, all: null, better: false };
  const run = (h: History) => (opts.inline ? Promise.resolve(fit(h, current)) : fitInWorker(h, current));
  const { train, test } = split(hist, ids);
  const useHoldout = countReviews(test) >= 30 && countReviews(train) >= MIN_REVIEWS * 0.8;
  const [fitted, wTrain] = await Promise.all([run(hist), useHoldout ? run(train) : null]);
  let holdout: OptimizeResult['holdout'] = null;
  if (wTrain) {
    const a = evaluate(current, test), b = evaluate(wTrain, test);
    holdout = { current: pick(a), fitted: pick(b), n: a.n };
  }
  const all = { current: pick(evaluate(current, hist)), fitted: pick(evaluate(fitted, hist)) };
  const better = all.fitted.log_loss < all.current.log_loss - 1e-4 && (!holdout || holdout.fitted.log_loss <= holdout.current.log_loss + 1e-4);
  return { ...base, enough: true, fitted, holdout, all, better };
}

const pick = (e: { log_loss: number; rmse: number }) => ({ log_loss: round(e.log_loss), rmse: round(e.rmse) });
const round = (x: number) => Math.round(x * 1e4) / 1e4;

/**
 * Save weights and recompute every card's memory state from its history with them.
 * Cards in review keep their last review date; their due date moves to match the new stability.
 */
export function applyWeights(db: DB, w: number[] | null, retention: number) {
  if (w !== null && !validWeights(w)) throw new Error('Weights must be 21 numbers within FSRS bounds');
  const weights = w ?? DEFAULT_WEIGHTS;
  const { hist, ids, last } = loadHistory(db);
  const latest = new Map<number, number>();
  ids.forEach((q, i) => latest.set(q, i)); // later sequences overwrite earlier ones
  const decay = -weights[20];
  const factor = Math.pow(0.9, 1 / decay) - 1;
  const interval = (s: number) => Math.max(1, Math.round((s / factor) * (Math.pow(retention, 1 / decay) - 1)));
  let updated = 0;
  tx(db, () => {
    if (w === null) db.prepare(`DELETE FROM settings WHERE key = 'fsrs_weights'`).run();
    else setSetting(db, 'fsrs_weights', w);
    setSetting(db, 'fsrs_weights_at', now());
    const get = db.prepare('SELECT card FROM srs_cards WHERE question_id = ?');
    const put = db.prepare('UPDATE srs_cards SET card = ?, due = ? WHERE question_id = ?');
    for (const [q, i] of latest) {
      const row = get.get(q) as { card: string } | undefined;
      if (!row) continue;
      const card = JSON.parse(row.card);
      const { s, d } = replay(weights, hist[i]);
      card.stability = s;
      card.difficulty = d;
      let due = Date.parse(card.due);
      if (card.state === 2) {
        const days = interval(s);
        due = last[i] + days * 864e5;
        card.scheduled_days = days;
        card.due = new Date(due).toISOString();
      }
      put.run(JSON.stringify(card), due, q);
      updated++;
    }
  });
  return { updated, weights };
}

export const DEFAULT_DECAY = FSRS6_DEFAULT_DECAY;
