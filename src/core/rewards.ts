// Study rewards for Hey Ann's screen-time wallet (rules agreed with the Hey Ann thread; docs/REWARDS.md).
//
// Everything here is computed from server facts only: server timestamps (attempts.answered_at, sessions.started_at),
// server grading and the schedule. Nothing an agent or the browser claims can raise a figure: the browser's own
// time_ms can only lower one. Events go to the reward_events outbox; a transport (defined by Orbit) ships them
// later. Pricing, rates and wallet caps belong to Hey Ann, not here.
import { type DB, now, getSetting, setSetting, tx } from './db.ts';
import { studyDay } from './srs.ts';

export const RULES = {
  /** Credit per attempt is capped at this server-measured gap... */
  capMs: 3 * 60_000,
  /** ...or this for written answers and code. */
  capLongMs: 6 * 60_000,
  /** A gap longer than this since the previous answer is idle time and earns nothing. */
  idleMs: 10 * 60_000,
  /** A session is closed (and its event emitted) once ended, or this long after its last answer. */
  closeAfterMs: 30 * 60_000,
  /** Ungraded written answers are waited for this long before a session is emitted without them. */
  graceMs: 48 * 3600_000,
  /** Questions younger than this when answered earn nothing (no "write easy questions, answer them"). */
  freshQuestionMs: 24 * 3600_000,
  /** Re-answering an item already answered correctly this recently earns nothing. */
  knownWindowMs: 24 * 3600_000,
  /** Sanity limit: never more study minutes than this per study day. */
  dayMaxMinutes: 180,
  /** Mastery thresholds, each paid once per leaf tag ever. */
  thresholds: [0.5, 0.7, 0.85],
  masteryMinAttempts: 10,
  masteryMinDays: 2,
  /** How far back sessions are considered. */
  lookbackMs: 14 * 864e5,
} as const;

export interface StudyEvent {
  event_id: string;
  kind: 'study_minutes';
  day: string;
  occurred_at: number;
  minutes: number;
  intervals: [number, number][];
  session_id: number;
  attempts_credited: number;
  /** Written answers still ungraded when this was emitted; a ":late" supplement may follow. */
  pending: number;
  supplement?: true;
}

export interface MasteryEvent {
  event_id: string;
  kind: 'mastery_up';
  day: string;
  occurred_at: number;
  tag: { id: number; path: string; title: string };
  threshold: number;
}

interface AttemptRow {
  id: number; question_id: number; answered_at: number; time_ms: number; grade_status: string; score: number | null;
  srs_before: string | null; type: string; long: number; q_created: number; grader: string | null;
}

/** Credited milliseconds and weight for each attempt of a session, in order. */
export function creditSession(db: DB, session: { id: number; started_at: number }) {
  const rows = db
    .prepare(
      `SELECT a.id, a.question_id, a.answered_at, a.time_ms, a.grade_status, a.score, a.srs_before, q.type,
         (q.type = 'code' OR q.type = 'short_answer') long, q.created_at q_created,
         (SELECT g.grader FROM grades g WHERE g.attempt_id = a.id ORDER BY g.id DESC LIMIT 1) grader
       FROM attempts a JOIN questions q ON q.id = a.question_id WHERE a.session_id = ? ORDER BY a.answered_at, a.id`,
    )
    .all(session.id) as unknown as AttemptRow[];
  const knownBefore = db.prepare(
    `SELECT 1 FROM attempts WHERE question_id = ? AND id != ? AND answered_at < ? AND answered_at >= ? AND score >= 0.8 LIMIT 1`,
  );
  const wrongBefore = db.prepare(
    `SELECT 1 FROM attempts WHERE question_id = ? AND id != ? AND answered_at < ? AND answered_at >= ? AND score IS NOT NULL AND score < 0.8 LIMIT 1`,
  );
  let prev = session.started_at;
  return rows.map((a) => {
    const gap = a.answered_at - prev;
    prev = a.answered_at;
    const cap = a.long ? RULES.capLongMs : RULES.capMs;
    // Server gap, capped; the browser's own figure can only lower it.
    const ms = gap <= 0 || gap > RULES.idleMs ? 0 : Math.min(gap, cap, Math.max(0, a.time_ms));
    const since = a.answered_at - RULES.knownWindowMs;
    let eligible = a.answered_at - a.q_created >= RULES.freshQuestionMs && !knownBefore.get(a.question_id, a.id, a.answered_at, since);
    if (eligible) {
      const isNew = a.srs_before === null;
      let due = false;
      if (!isNew) {
        try {
          due = new Date(JSON.parse(a.srs_before!).due).getTime() <= a.answered_at;
        } catch {
          due = false;
        }
      }
      eligible = isNew || due || !!wrongBefore.get(a.question_id, a.id, a.answered_at, since);
    }
    let weight = 0;
    if (a.grade_status === 'auto') weight = 1;
    else if (a.grade_status === 'self') weight = 0.5;
    else if (a.grade_status !== 'pending') weight = a.grader && a.grader.startsWith('agent:') ? 1 : 0.5;
    return { id: a.id, at: a.answered_at, ms: eligible ? ms : 0, weight, pending: a.grade_status === 'pending' };
  });
}

function mergeIntervals(xs: [number, number][]): [number, number][] {
  const s = xs.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  for (const iv of s) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

const round1 = (x: number) => Math.floor(x * 10) / 10;

export class Rewards {
  db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  /** When rewards started: sessions before it never pay, and mastery already reached then is the baseline. */
  private startedAt(at: number): number {
    let t = getSetting<number | null>(this.db, 'rewards_started_at', null);
    if (t === null) {
      t = at;
      setSetting(this.db, 'rewards_started_at', t);
      // Baseline: thresholds already reached are recorded as delivered, so turning this on pays no windfall.
      for (const m of this.masteryCrossings(at)) this.insert(m, at, true);
    }
    return t;
  }

  private has(eventId: string) {
    return !!this.db.prepare('SELECT 1 FROM reward_events WHERE event_id = ?').get(eventId);
  }

  private insert(e: StudyEvent | MasteryEvent, at: number, baseline = false) {
    this.db
      .prepare('INSERT OR IGNORE INTO reward_events(event_id, kind, day, occurred_at, payload, created_at, delivered_at) VALUES(?,?,?,?,?,?,?)')
      .run(e.event_id, e.kind, e.day, e.occurred_at, JSON.stringify(baseline ? { ...e, baseline: true } : e), at, baseline ? at : null);
  }

  private dayMinutes(day: string): number {
    const rows = this.db.prepare(`SELECT payload FROM reward_events WHERE kind = 'study_minutes' AND day = ? AND payload NOT LIKE '%"baseline":true%'`).all(day) as { payload: string }[];
    return rows.reduce((s, r) => s + (JSON.parse(r.payload).minutes ?? 0), 0);
  }

  /** Leaf tags past a threshold with enough evidence; event ids say which are already recorded. */
  private masteryCrossings(at: number): MasteryEvent[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.path, t.name, a.theta,
           (SELECT COUNT(*) FROM attempts x JOIN question_tags qt ON qt.question_id = x.question_id JOIN questions q ON q.id = x.question_id
              WHERE qt.tag_id = t.id AND x.score IS NOT NULL AND x.answered_at - q.created_at >= ?) n,
           (SELECT COUNT(DISTINCT x.study_day) FROM attempts x JOIN question_tags qt ON qt.question_id = x.question_id
              WHERE qt.tag_id = t.id AND x.score IS NOT NULL) days
         FROM ability a JOIN tags t ON t.id = a.tag_id
         WHERE t.merged_into_id IS NULL AND NOT EXISTS (SELECT 1 FROM tags c WHERE c.parent_id = t.id AND c.merged_into_id IS NULL)`,
      )
      .all(RULES.freshQuestionMs) as { id: number; path: string; name: string; theta: number; n: number; days: number }[];
    const out: MasteryEvent[] = [];
    for (const r of rows) {
      if (r.n < RULES.masteryMinAttempts || r.days < RULES.masteryMinDays) continue;
      const mastery = 1 / (1 + Math.exp(-r.theta));
      for (const th of RULES.thresholds)
        if (mastery >= th)
          out.push({ event_id: `socrates:mastery:${r.id}:${Math.round(th * 100)}`, kind: 'mastery_up', day: studyDay(at), occurred_at: at, tag: { id: r.id, path: r.path, title: r.name }, threshold: Math.round(th * 100) });
    }
    return out;
  }

  /** Compute and record any new events. Safe to call often; every event is idempotent by id. */
  tick(at = now()): { study: number; mastery: number } {
    return tx(this.db, () => {
      const started = this.startedAt(at);
      let study = 0, mastery = 0;
      const sessions = this.db
        .prepare(
          `SELECT s.id, s.started_at, s.ended_at, (SELECT MAX(answered_at) FROM attempts WHERE session_id = s.id) last
           FROM sessions s WHERE s.started_at >= ? ORDER BY s.id`,
        )
        .all(Math.max(started, at - RULES.lookbackMs)) as { id: number; started_at: number; ended_at: number | null; last: number | null }[];
      for (const s of sessions) {
        if (s.last === null) continue;
        const closedAt = s.ended_at ?? s.last + RULES.closeAfterMs;
        if (closedAt > at) continue;
        const id = `socrates:study:${s.id}`;
        const credited = creditSession(this.db, s);
        const pending = credited.filter((c) => c.pending).length;
        const total = credited.reduce((sum, c) => sum + c.ms * c.weight, 0) / 60_000;
        if (!this.has(id)) {
          if (pending && at - closedAt < RULES.graceMs) continue; // wait for grading
          const counted = credited.filter((c) => c.ms > 0 && c.weight > 0);
          if (!counted.length) continue;
          const day = studyDay(s.last);
          const minutes = round1(Math.min(total, Math.max(0, RULES.dayMaxMinutes - this.dayMinutes(day))));
          if (minutes <= 0) continue;
          this.insert({
            event_id: id, kind: 'study_minutes', day, occurred_at: s.last, minutes,
            intervals: mergeIntervals(counted.map((c) => [c.at - c.ms, c.at])), session_id: s.id, attempts_credited: counted.length, pending,
          }, at);
          study++;
        } else if (!this.has(`${id}:late`)) {
          // Written answers graded after the session was emitted: one supplement with only the extra minutes.
          const first = JSON.parse((this.db.prepare('SELECT payload FROM reward_events WHERE event_id = ?').get(id) as { payload: string }).payload) as StudyEvent;
          if (!first.pending || pending) continue;
          const day = first.day;
          const extra = round1(Math.min(total - first.minutes, Math.max(0, RULES.dayMaxMinutes - this.dayMinutes(day))));
          if (extra < 1) continue;
          const counted = credited.filter((c) => c.ms > 0 && c.weight > 0);
          this.insert({
            event_id: `${id}:late`, kind: 'study_minutes', day, occurred_at: s.last, minutes: extra,
            intervals: mergeIntervals(counted.map((c) => [c.at - c.ms, c.at])), session_id: s.id, attempts_credited: counted.length, pending: 0, supplement: true,
          }, at);
          study++;
        }
      }
      for (const m of this.masteryCrossings(at))
        if (!this.has(m.event_id)) {
          this.insert(m, at);
          mastery++;
        }
      return { study, mastery };
    });
  }

  /** Recorded events, newest first (baseline rows excluded). */
  list(opts: { limit?: number; undelivered?: boolean } = {}) {
    const rows = this.db
      .prepare(
        `SELECT payload, created_at, delivered_at FROM reward_events WHERE payload NOT LIKE '%"baseline":true%' ${opts.undelivered ? 'AND delivered_at IS NULL' : ''}
         ORDER BY created_at DESC, event_id LIMIT ?`,
      )
      .all(opts.limit ?? 50) as { payload: string; created_at: number; delivered_at: number | null }[];
    return rows.map((r) => ({ ...JSON.parse(r.payload), created_at: r.created_at, delivered_at: r.delivered_at }));
  }
}
