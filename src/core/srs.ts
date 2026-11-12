import { fsrs, generatorParameters, createEmptyCard, Rating, FSRS6_DEFAULT_DECAY, type Card, type Grade } from 'ts-fsrs';
import { type DB, getSetting } from './db.ts';

export const DAY_START_HOUR = 4;

/** Study day key (local time, day rolls over at 4am). */
export function studyDay(ts: number): string {
  const d = new Date(ts - DAY_START_HOUR * 3600_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Timestamp at which the current study day ends (next 4am local). */
export function endOfStudyDay(ts: number): number {
  const d = new Date(ts - DAY_START_HOUR * 3600_000);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime() + DAY_START_HOUR * 3600_000;
}

export interface Limits {
  new_per_day: number;
  reviews_per_day: number;
  retention: number;
  /** FSRS weights fitted to your history, or null for the defaults. */
  weights: number[] | null;
}

export function limits(db: DB): Limits {
  return {
    new_per_day: getSetting(db, 'new_per_day', 20),
    reviews_per_day: getSetting(db, 'reviews_per_day', 200),
    retention: getSetting(db, 'retention', 0.9),
    weights: fittedWeights(db),
  };
}

function fittedWeights(db: DB): number[] | null {
  const w = getSetting<number[] | null>(db, 'fsrs_weights', null);
  return Array.isArray(w) && w.length === 21 && w.every((x) => typeof x === 'number' && Number.isFinite(x)) ? w : null;
}

/** Forgetting-curve decay in use (the fitted w20, or the FSRS-6 default). */
export function fsrsDecay(db: DB): number {
  return fittedWeights(db)?.[20] ?? FSRS6_DEFAULT_DECAY;
}

const schedulers = new Map<string, ReturnType<typeof fsrs>>();
export function scheduler(retention = 0.9, weights: number[] | null = null) {
  const key = retention + '|' + (weights?.join(',') ?? '');
  let s = schedulers.get(key);
  if (!s) {
    s = fsrs(generatorParameters({ request_retention: retention, enable_fuzz: true, enable_short_term: true, ...(weights ? { w: weights } : {}) }));
    if (schedulers.size > 20) schedulers.clear();
    schedulers.set(key, s);
  }
  return s;
}

/** FSRS-6 forgetting curve: probability of recall after `elapsedDays` with stability S. */
export function retrievability(stability: number, elapsedDays: number, decay = FSRS6_DEFAULT_DECAY): number {
  if (stability <= 0) return 0;
  const factor = Math.pow(0.9, -1 / decay) - 1;
  return Math.pow(1 + (factor * Math.max(0, elapsedDays)) / stability, -decay);
}

export function cardRetrievability(card: { stability: number; last_review?: Date | string | null }, at: number, decay = FSRS6_DEFAULT_DECAY): number {
  if (!card.last_review) return 0;
  const elapsed = (at - new Date(card.last_review).getTime()) / 864e5;
  return retrievability(card.stability, elapsed, decay);
}

/** Typical answer time for a type, used when a question has no history yet. */
const BASELINE_MS: Record<string, number> = {
  true_false: 6000, mcq_single: 10000, mcq_multi: 15000, numeric: 25000, fill_blank: 15000, flashcard: 8000, short_answer: 60000,
};

/**
 * Map an attempt to an FSRS rating.
 *  score < 0.5 -> Again; < 0.8 -> Hard; hint used or low confidence -> Hard;
 *  fast (< 50% of baseline) and confident -> Easy; otherwise Good.
 */
export function deriveRating(a: { score: number; time_ms: number; confidence?: number | null; hints_used?: number; baseline_ms: number }): Grade {
  if (a.score < 0.5) return Rating.Again;
  if (a.score < 0.8) return Rating.Hard;
  if ((a.hints_used ?? 0) > 0) return Rating.Hard;
  if (a.confidence != null && a.confidence <= 2) return Rating.Hard;
  if (a.time_ms > a.baseline_ms * 2.5) return Rating.Hard;
  if (a.time_ms < a.baseline_ms * 0.5 && (a.confidence == null || a.confidence >= 4)) return Rating.Easy;
  return Rating.Good;
}

export function baselineMs(db: DB, questionId: number, type: string): number {
  const rows = db
    .prepare('SELECT time_ms FROM attempts WHERE question_id = ? AND is_correct = 1 ORDER BY id DESC LIMIT 7')
    .all(questionId) as { time_ms: number }[];
  if (rows.length < 2) return BASELINE_MS[type] ?? 15000;
  const s = rows.map((r) => r.time_ms).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function loadCard(db: DB, questionId: number): { card: Card; isNew: boolean; raw: string | null } {
  const row = db.prepare('SELECT card FROM srs_cards WHERE question_id = ?').get(questionId) as { card: string } | undefined;
  if (!row) return { card: createEmptyCard(new Date()), isNew: true, raw: null };
  const c = JSON.parse(row.card);
  return { card: { ...c, due: new Date(c.due), last_review: c.last_review ? new Date(c.last_review) : undefined }, isNew: false, raw: row.card };
}

/** Apply a review. Returns the card JSON before the review (null if it was new) and the new due time. */
export function review(db: DB, questionId: number, rating: Grade, at: number) {
  const { card, raw } = loadCard(db, questionId);
  const l = limits(db);
  const next = scheduler(l.retention, l.weights).next(card, new Date(at), rating).card;
  const json = JSON.stringify(next);
  db.prepare(
    `INSERT INTO srs_cards(question_id, card, due, state, reps, lapses, last_review) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(question_id) DO UPDATE SET card=excluded.card, due=excluded.due, state=excluded.state,
       reps=excluded.reps, lapses=excluded.lapses, last_review=excluded.last_review`,
  ).run(questionId, json, next.due.getTime(), next.state, next.reps, next.lapses, at);
  return { before: raw, due: next.due.getTime(), stability: next.stability, state: next.state };
}

export { Rating };
