import { z } from 'zod';
import { type DB, tx, now, idSet } from './db.ts';
import { Questions, type Question } from './questions.ts';
import { QTYPES, type QType, autoGrade, RESPONSES, AUTO_GRADED, codeAutoGraded, clozeParts, type GradeResult } from './qtypes.ts';
import { runJs, redact } from './coderun.ts';
import { studyDay, endOfStudyDay, limits, review, deriveRating, baselineMs, cardRetrievability, fsrsDecay, loadCard, Rating } from './srs.ts';
import { Engine, sigmoid, type EngineBefore } from './engine.ts';
import { getSetting } from './db.ts';

export const MODES = ['srs', 'adaptive', 'weak', 'practice', 'exam'] as const;
export type Mode = (typeof MODES)[number];

export const SessionConfig = z.object({
  /**
   * srs: due reviews + new within daily limits.
   * adaptive: mixes due, weak and new, aiming for ~80% predicted success.
   * weak: concentrates on the lowest-mastery tags.
   * practice: weighted random sample.
   * exam: random sample spread across tags; no feedback until the end.
   */
  mode: z.enum(MODES).default('srs'),
  /** Whole-session time limit in seconds (any mode). */
  time_limit_s: z.number().int().min(30).max(6 * 3600).optional(),
  tags: z.array(z.string()).optional(),
  types: z.array(z.enum(QTYPES as [QType, ...QType[]])).optional(),
  difficulty: z.tuple([z.number().int().min(1).max(5), z.number().int().min(1).max(5)]).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  include_new: z.boolean().optional(),
  question_ids: z.array(z.number().int()).optional(),
});
export type SessionConfig = z.infer<typeof SessionConfig>;

export const AttemptInput = z.object({
  session_id: z.number().int().nullable().optional(),
  question_id: z.number().int(),
  response: z.unknown(),
  shown_at: z.number(),
  time_ms: z.number().int().min(0),
  first_input_ms: z.number().int().min(0).nullable().optional(),
  answer_changes: z.number().int().min(0).default(0),
  hints_used: z.number().int().min(0).default(0),
  confidence: z.number().int().min(1).max(4).nullable().optional(),
  /** Flashcards: the rating the user picked (1..4). */
  self_rating: z.number().int().min(1).max(4).optional(),
  /** Short answer: user grades themselves instead of waiting for the agent (0..1). */
  self_score: z.number().min(0).max(1).optional(),
  /** Exam: the question was left blank. Scores 0 without grading the default state. */
  unanswered: z.boolean().optional(),
  events: z.array(z.object({ t: z.number(), kind: z.string(), data: z.unknown().optional() })).max(500).optional(),
});
export type AttemptInput = z.infer<typeof AttemptInput>;

const SELF_RATING_SCORE = { 1: 0, 2: 0.6, 3: 0.9, 4: 1 } as const;

export class Study {
  db: DB;
  q: Questions;
  engine: Engine;
  constructor(db: DB, q: Questions) {
    this.db = db;
    this.q = q;
    this.engine = new Engine(db);
  }

  /**
   * Score every candidate on a weighted mix and take the best:
   *   due      overdue-ness (1 - recall probability), boosted when actually due
   *   weak     low mastery of the question's weakest tag
   *   target   predicted success close to 80% (hard enough to learn from, not hopeless)
   *   novelty  never seen (capped by the daily new limit)
   * Questions answered in the last 10 minutes are skipped.
   */
  private adaptiveQueue(pool: number[], c: SessionConfig, at: number): number[] {
    const W = c.mode === 'weak' ? { due: 0.4, weak: 1.6, target: 0.6, novelty: 0.2 } : { due: 1.0, weak: 0.6, target: 0.8, novelty: 0.5 };
    const inPool = idSet(this.db, 'pool_ids', pool);
    const cards = new Map(
      (this.db.prepare(`SELECT question_id, card, due FROM srs_cards WHERE question_id IN (${inPool})`).all() as { question_id: number; card: string; due: number }[]).map((r) => [r.question_id, r]),
    );
    const recent = new Set((this.db.prepare(`SELECT DISTINCT question_id FROM attempts WHERE answered_at > ?`).all(at - 600_000) as { question_id: number }[]).map((r) => r.question_id));
    const p = this.engine.predictMany(pool);
    const mastery = this.engine.mastery();
    const leafTags = new Map<number, number[]>();
    for (const r of this.db.prepare(`SELECT question_id, tag_id FROM question_tags WHERE question_id IN (${inPool})`).all() as { question_id: number; tag_id: number }[])
      leafTags.set(r.question_id, [...(leafTags.get(r.question_id) ?? []), r.tag_id]);
    const horizon = endOfStudyDay(at);
    const decayW = fsrsDecay(this.db);
    let newLeft = Math.max(0, limits(this.db).new_per_day - this.todayCounts(at).new_seen);
    const scored = pool
      .filter((id) => !recent.has(id))
      .map((id) => {
        const card = cards.get(id);
        const r = card ? cardRetrievability(JSON.parse(card.card), at, decayW) : 0;
        const due = card ? (card.due <= horizon ? 1 + (1 - r) : (1 - r) * 0.5) : 0;
        const tagMastery = (leafTags.get(id) ?? []).map((t) => mastery.get(t)).filter((m) => m && m.n >= 3).map((m) => m!.mastery);
        const weak = tagMastery.length ? 1 - Math.min(...tagMastery) : 0.4;
        const pred = p.get(id) ?? 0.5;
        const target = 1 - Math.min(1, Math.abs(pred - 0.8) / 0.4);
        const novelty = card ? 0 : 1;
        return { id, isNew: !card, score: W.due * due + W.weak * weak + W.target * target + W.novelty * novelty + Math.random() * 0.15 };
      })
      .sort((a, b) => b.score - a.score);
    const out: number[] = [];
    for (const s of scored) {
      if (out.length >= (c.limit ?? 20)) break;
      if (s.isNew) { if (newLeft <= 0 || c.include_new === false) continue; newLeft--; }
      out.push(s.id);
    }
    return this.interleave(out);
  }

  /** Exam blueprint: round-robin over primary tags so every topic is represented, random within each. */
  private examQueue(pool: number[], limit: number): number[] {
    const rows = this.db
      // Flashcards are self-rated, so they don't belong in an exam.
      .prepare(`SELECT q.id, (SELECT MIN(tag_id) FROM question_tags WHERE question_id = q.id) tag FROM questions q WHERE q.id IN (${idSet(this.db, 'pool_ids', pool)}) AND q.type != 'flashcard'`)
      .all() as { id: number; tag: number }[];
    const buckets = new Map<number, number[]>();
    for (const r of rows.sort(() => Math.random() - 0.5)) buckets.set(r.tag, [...(buckets.get(r.tag) ?? []), r.id]);
    const lists = [...buckets.values()].sort(() => Math.random() - 0.5);
    const out: number[] = [];
    for (let i = 0; out.length < limit && lists.some((l) => l.length > i); i++)
      for (const l of lists) if (l[i] !== undefined && out.length < limit) out.push(l[i]);
    return out.sort(() => Math.random() - 0.5);
  }

  /** Weakest tags (lowest mastery with enough evidence) as paths. */
  weakestTagPaths(n = 3): string[] {
    // Leaf tags only (parents just average their children), below 65% mastery; else the single weakest.
    const rows = this.db
      .prepare(
        `SELECT t.path, a.theta FROM ability a JOIN tags t ON t.id = a.tag_id
         WHERE t.merged_into_id IS NULL AND a.n >= 3 AND NOT EXISTS (SELECT 1 FROM tags c WHERE c.parent_id = t.id AND c.merged_into_id IS NULL)
         ORDER BY a.theta ASC`,
      )
      .all() as { path: string; theta: number }[];
    const weak = rows.filter((r) => sigmoid(r.theta) < 0.65).slice(0, n);
    return (weak.length ? weak : rows.slice(0, 1)).map((r) => r.path);
  }

  /** Active, unflagged question ids matching the filters. */
  private pool(c: SessionConfig): number[] {
    const where = [`q.status = 'active'`, 'q.flagged_reason IS NULL'];
    const args: any[] = [];
    if (c.question_ids?.length) { where.push(`q.id IN (${c.question_ids.map(() => '?').join(',')})`); args.push(...c.question_ids); }
    if (c.tags?.length) {
      const ids = new Set<number>();
      for (const p of c.tags) {
        const r = this.q.tags.resolve(p);
        if (r.tag_id) for (const d of this.q.tags.descendantIds(r.tag_id)) ids.add(d);
      }
      if (!ids.size) return [];
      where.push(`q.id IN (SELECT question_id FROM question_tags WHERE tag_id IN (${[...ids].join(',')}))`);
    }
    if (c.types?.length) { where.push(`q.type IN (${c.types.map(() => '?').join(',')})`); args.push(...c.types); }
    if (c.difficulty) { where.push('q.difficulty BETWEEN ? AND ?'); args.push(...c.difficulty); }
    return (this.db.prepare(`SELECT q.id FROM questions q WHERE ${where.join(' AND ')}`).all(...args) as { id: number }[]).map((r) => r.id);
  }

  todayCounts(at = now()) {
    const day = studyDay(at);
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS reviews,
           SUM(CASE WHEN srs_before IS NULL AND rating IS NOT NULL THEN 1 ELSE 0 END) AS new_seen
         FROM attempts WHERE study_day = ?`,
      )
      .get(day) as { reviews: number; new_seen: number | null };
    return { reviews: r.reviews, new_seen: r.new_seen ?? 0 };
  }

  /** Build the ordered question queue for a session. */
  buildQueue(c: SessionConfig, at = now()): number[] {
    if (c.mode === 'weak' && !c.tags?.length && !c.question_ids?.length) {
      const weakest = this.weakestTagPaths(5);
      if (weakest.length) c = { ...c, tags: weakest };
    }
    const pool = this.pool(c);
    if (!pool.length) return [];
    if (c.mode === 'adaptive' || c.mode === 'weak') return this.adaptiveQueue(pool, c, at);
    if (c.mode === 'exam') return this.examQueue(pool, c.limit ?? 30);
    const inPool = idSet(this.db, 'pool_ids', pool);
    if (c.mode === 'practice') {
      const stats = new Map(
        (this.db
          .prepare(`SELECT question_id, COUNT(*) n, AVG(score) acc FROM attempts WHERE question_id IN (${inPool}) AND score IS NOT NULL GROUP BY question_id`)
          .all() as { question_id: number; n: number; acc: number }[]).map((r) => [r.question_id, r]),
      );
      const scored = pool.map((id) => {
        const s = stats.get(id);
        const weight = Math.random() + (s ? (1 - s.acc) * 0.6 : 0.35);
        return { id, weight };
      });
      scored.sort((a, b) => b.weight - a.weight);
      return this.interleave(scored.slice(0, c.limit ?? 20).map((s) => s.id));
    }
    // SRS: due reviews (lowest recall probability first), then new questions within today's limits.
    const lim = limits(this.db);
    const today = this.todayCounts(at);
    const horizon = endOfStudyDay(at);
    const decayW = fsrsDecay(this.db);
    const due = (this.db
      .prepare(`SELECT question_id, card FROM srs_cards WHERE due <= ? AND question_id IN (${inPool})`)
      .all(horizon) as { question_id: number; card: string }[])
      .map((r) => ({ id: r.question_id, r: cardRetrievability(JSON.parse(r.card), at, decayW) }))
      .sort((a, b) => a.r - b.r)
      .slice(0, Math.max(0, lim.reviews_per_day - today.reviews))
      .map((r) => r.id);
    let fresh: number[] = [];
    if (c.include_new !== false) {
      const newLeft = Math.max(0, lim.new_per_day - today.new_seen);
      fresh = (this.db
        .prepare(`SELECT id FROM questions WHERE id IN (${inPool}) AND id NOT IN (SELECT question_id FROM srs_cards) ORDER BY difficulty, created_at LIMIT ?`)
        .all(newLeft) as { id: number }[]).map((r) => r.id);
    }
    // Spread new questions through the reviews (one every ~4).
    const out: number[] = [];
    let i = 0, j = 0;
    while (i < due.length || j < fresh.length) {
      if (j < fresh.length && (i >= due.length || (out.length + 1) % 4 === 0)) out.push(fresh[j++]);
      else out.push(due[i++]);
    }
    return this.interleave(c.limit ? out.slice(0, c.limit) : out);
  }

  /** Reorder so that questions sharing a group or primary tag are not back to back (best effort). */
  interleave(ids: number[]): number[] {
    if (ids.length < 3) return ids;
    const meta = new Map(
      (this.db
        .prepare(
          `SELECT q.id, q.group_id, (SELECT MIN(tag_id) FROM question_tags WHERE question_id = q.id) AS tag
           FROM questions q WHERE q.id IN (${ids.join(',')})`,
        )
        .all() as { id: number; group_id: string | null; tag: number | null }[]).map((r) => [r.id, r]),
    );
    const rest = [...ids];
    const out: number[] = [];
    while (rest.length) {
      const prev = out.length ? meta.get(out[out.length - 1]) : undefined;
      let k = rest.findIndex((id) => {
        const m = meta.get(id);
        return !prev || ((!m?.group_id || m.group_id !== prev.group_id) && m?.tag !== prev.tag);
      });
      if (k < 0) k = rest.findIndex((id) => !prev?.group_id || meta.get(id)?.group_id !== prev.group_id);
      if (k < 0) k = 0;
      out.push(rest.splice(k, 1)[0]);
    }
    return out;
  }

  startSession(input: unknown) {
    const c = SessionConfig.parse(input);
    const queue = this.buildQueue(c);
    const info = this.db
      .prepare('INSERT INTO sessions(mode, config, queue, started_at) VALUES(?, ?, ?, ?)')
      .run(c.mode, JSON.stringify(c), JSON.stringify(queue), now());
    const qs = this.q.getMany(queue);
    return { session_id: Number(info.lastInsertRowid), mode: c.mode, time_limit_s: c.time_limit_s ?? null, questions: qs.map((x) => this.q.toPublic(x)) };
  }

  /** Remaining (unanswered) questions of an existing session, e.g. one an agent created. */
  loadSession(id: number) {
    const s = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!s) throw new Error(`Session ${id} not found.`);
    const done = new Set((this.db.prepare('SELECT question_id FROM attempts WHERE session_id = ?').all(id) as { question_id: number }[]).map((r) => r.question_id));
    const queue = (JSON.parse(s.queue) as number[]).filter((qid) => !done.has(qid));
    const qs = this.q.getMany(queue).filter((q) => q.status === 'active');
    const cfg = JSON.parse(s.config);
    return {
      session_id: id, mode: s.mode, answered: done.size, ended: !!s.ended_at, started_at: s.started_at,
      time_limit_s: cfg.time_limit_s ?? null, questions: qs.map((x) => this.q.toPublic(x)),
    };
  }

  endSession(id: number) {
    this.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(now(), id);
    return this.sessionSummary(id);
  }

  sessionSummary(id: number) {
    return this.db
      .prepare(
        `SELECT COUNT(*) AS answered, SUM(is_correct) AS correct, AVG(score) AS avg_score, SUM(time_ms) AS time_ms,
           SUM(CASE WHEN grade_status = 'pending' THEN 1 ELSE 0 END) AS pending
         FROM attempts WHERE session_id = ?`,
      )
      .get(id);
  }

  hint(questionId: number, index: number): string | null {
    const q = this.q.get(questionId);
    return q?.hints[index] ?? null;
  }

  /** Grade and record an attempt, update the schedule, and return the answer for feedback. */
  /** Submit, running JavaScript tests first for auto-graded code questions. */
  async submitAsync(input: unknown) {
    const a = AttemptInput.parse(input);
    const q = this.q.get(a.question_id);
    if (q?.type === 'code' && codeAutoGraded(q.spec) && a.self_score === undefined && !a.unanswered) {
      const code = String((a.response as any)?.code ?? '');
      const r = await runJs(code, q.spec.tests, q.spec.function_name ?? 'solution');
      const score = r.total ? r.passed / r.total : 0;
      return this.submit(a, { codeGrade: { score: +score.toFixed(3), correct: score === 1, detail: redact(r) } });
    }
    return this.submit(a);
  }

  submit(input: unknown, opts: { codeGrade?: GradeResult } = {}) {
    const a = AttemptInput.parse(input);
    return tx(this.db, () => {
      const q = this.q.get(a.question_id);
      if (!q) throw new Error(`Question ${a.question_id} not found.`);
      const resp = RESPONSES[q.type].safeParse(a.response ?? {});
      if (!resp.success) throw new Error(`Bad response for ${q.type}: ${resp.error.issues.map((i) => i.message).join('; ')}`);
      const at = now();
      let score: number | null = null;
      let correct: boolean | null = null;
      let detail: unknown;
      let gradeStatus: 'auto' | 'self' | 'pending';
      if (a.unanswered) {
        score = 0; correct = false; gradeStatus = 'auto';
      } else if (opts.codeGrade) {
        ({ score, correct, detail } = opts.codeGrade);
        gradeStatus = 'auto';
      } else if (AUTO_GRADED.includes(q.type)) {
        const g = autoGrade(q.type, q.spec, resp.data, q.prompt)!;
        score = g.score; correct = g.correct; detail = g.detail; gradeStatus = 'auto';
      } else if (q.type === 'flashcard') {
        const r = (a.self_rating ?? 3) as 1 | 2 | 3 | 4;
        score = SELF_RATING_SCORE[r]; correct = r >= 3; gradeStatus = 'self';
      } else if (a.self_score !== undefined) {
        score = a.self_score; correct = a.self_score >= 0.8; gradeStatus = 'self';
      } else {
        gradeStatus = 'pending';
      }

      // What the models expected before this answer (for forgetting curves and calibration).
      const prev = loadCard(this.db, q.id);
      const rPred = prev.isNew ? null : cardRetrievability(prev.card, a.shown_at, fsrsDecay(this.db));
      const elapsedDays = !prev.isNew && prev.card.last_review ? (a.shown_at - new Date(prev.card.last_review).getTime()) / 864e5 : null;
      let pPred = this.engine.predict(q.id);
      let engineBefore: EngineBefore | null = null;

      let rating: number | null = null;
      let srs: ReturnType<typeof review> | null = null;
      let leech = false;
      if (score !== null) {
        rating = q.type === 'flashcard' && a.self_rating
          ? a.self_rating
          : deriveRating({ score, time_ms: a.time_ms, confidence: a.confidence, hints_used: a.hints_used, baseline_ms: baselineMs(this.db, q.id, q.type) });
        srs = review(this.db, q.id, rating as any, at);
        const e = this.engine.update(q.id, score);
        pPred = e.p;
        engineBefore = e.before;
        leech = this.checkLeech(q.id);
      }
      const shown = new Date(a.shown_at);
      const info = this.db
        .prepare(
          `INSERT INTO attempts(question_id, question_version, session_id, response, is_correct, score, grade_status, confidence,
             hints_used, time_ms, first_input_ms, answer_changes, shown_at, answered_at, local_hour, weekday, study_day, rating, srs_before,
             r_pred, p_pred, elapsed_days, engine_before)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          q.id, q.version, a.session_id ?? null, JSON.stringify(resp.data), correct === null ? null : correct ? 1 : 0, score, gradeStatus,
          a.confidence ?? null, a.hints_used, a.time_ms, a.first_input_ms ?? null, a.answer_changes, a.shown_at, at,
          shown.getHours(), shown.getDay(), studyDay(a.shown_at), rating, srs?.before ?? null,
          rPred, pPred, elapsedDays, engineBefore ? JSON.stringify(engineBefore) : null,
        );
      const attemptId = Number(info.lastInsertRowid);
      if (a.events?.length) {
        const ev = this.db.prepare('INSERT INTO attempt_events(attempt_id, t_ms, kind, data) VALUES(?,?,?,?)');
        for (const e of a.events) ev.run(attemptId, Math.round(e.t), e.kind, e.data === undefined ? null : JSON.stringify(e.data));
      }
      return {
        attempt_id: attemptId,
        grade_status: gradeStatus,
        score,
        correct,
        detail,
        rating,
        next_due: srs?.due ?? null,
        answer: q.type === 'cloze' ? { blanks: clozeParts(q.prompt) } : q.spec,
        explanation: q.explanation,
        predicted: +pPred.toFixed(3),
        leech,
      };
    });
  }

  /** Auto-suspend questions forgotten too often: they need rewriting, not more reviews. */
  private checkLeech(questionId: number): boolean {
    const threshold = getSetting(this.db, 'leech_threshold', 6);
    const row = this.db.prepare('SELECT c.lapses, q.flagged_reason FROM srs_cards c JOIN questions q ON q.id = c.question_id WHERE c.question_id = ?').get(questionId) as
      | { lapses: number; flagged_reason: string | null }
      | undefined;
    if (!row || row.lapses < threshold || row.flagged_reason) return false;
    this.db.prepare('UPDATE questions SET flagged_reason = ? WHERE id = ?').run(`Leech: forgotten ${row.lapses} times. Rewrite it or split it into smaller questions.`, questionId);
    return true;
  }

  /** Undo the most recent attempt: restores the schedule and calibration as they were. */
  undo(attemptId: number) {
    return tx(this.db, () => {
      const last = this.db.prepare('SELECT MAX(id) id FROM attempts').get() as { id: number };
      if (last.id !== attemptId) throw new Error('Only the most recent answer can be undone.');
      const a = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId) as any;
      if (a.rating !== null) {
        if (a.srs_before) {
          const c = JSON.parse(a.srs_before);
          this.db.prepare('UPDATE srs_cards SET card = ?, due = ?, state = ?, reps = ?, lapses = ?, last_review = ? WHERE question_id = ?')
            .run(a.srs_before, new Date(c.due).getTime(), c.state, c.reps, c.lapses, c.last_review ? new Date(c.last_review).getTime() : null, a.question_id);
        } else this.db.prepare('DELETE FROM srs_cards WHERE question_id = ?').run(a.question_id);
      }
      if (a.engine_before) this.engine.restore(a.question_id, JSON.parse(a.engine_before));
      // A leech flag set by this answer goes too.
      this.db.prepare(`UPDATE questions SET flagged_reason = NULL WHERE id = ? AND flagged_reason LIKE 'Leech:%'`).run(a.question_id);
      this.db.prepare('DELETE FROM attempt_events WHERE attempt_id = ?').run(attemptId);
      this.db.prepare('DELETE FROM grades WHERE attempt_id = ?').run(attemptId);
      this.db.prepare('DELETE FROM attempts WHERE id = ?').run(attemptId);
      return { undone: attemptId, question_id: a.question_id };
    });
  }

  /** Record a grade for a pending (or any) attempt: agent grading, self grading or override. */
  grade(attemptId: number, g: { score: number; feedback?: string; rubric_scores?: unknown; grader: string }) {
    return tx(this.db, () => {
      const a = this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId) as any;
      if (!a) throw new Error(`Attempt ${attemptId} not found.`);
      const q = this.q.get(a.question_id)!;
      const score = Math.max(0, Math.min(1, g.score));
      this.db
        .prepare('INSERT INTO grades(attempt_id, score, feedback, rubric_scores, grader, created_at) VALUES(?,?,?,?,?,?)')
        .run(attemptId, score, g.feedback ?? null, g.rubric_scores === undefined ? null : JSON.stringify(g.rubric_scores), g.grader, now());
      const wasPending = a.grade_status === 'pending';
      const rating = deriveRating({ score, time_ms: a.time_ms, confidence: a.confidence, hints_used: a.hints_used, baseline_ms: baselineMs(this.db, q.id, q.type) });
      // Only move the schedule if no newer graded attempt exists for this question.
      const newer = this.db.prepare(`SELECT 1 FROM attempts WHERE question_id = ? AND id > ? AND rating IS NOT NULL LIMIT 1`).get(q.id, attemptId);
      let srsBefore = a.srs_before;
      if (!newer) {
        if (!wasPending && a.srs_before !== undefined) {
          // Override of an already-scheduled attempt: rewind to the pre-attempt card, then re-apply.
          if (a.srs_before) this.db.prepare('UPDATE srs_cards SET card = ? WHERE question_id = ?').run(a.srs_before, q.id);
          else this.db.prepare('DELETE FROM srs_cards WHERE question_id = ?').run(q.id);
        }
        const r = review(this.db, q.id, rating, a.answered_at > now() - 864e5 * 2 ? now() : a.answered_at);
        if (wasPending) srsBefore = r.before;
      }
      let engineBefore = a.engine_before;
      if (wasPending) {
        const e = this.engine.update(q.id, score);
        engineBefore = JSON.stringify(e.before);
        this.db.prepare('UPDATE attempts SET p_pred = ? WHERE id = ?').run(e.p, attemptId);
        this.checkLeech(q.id);
      } else this.engine.adjust(q.id, score - (a.score ?? 0));
      this.db.prepare('UPDATE attempts SET engine_before = ? WHERE id = ?').run(engineBefore, attemptId);
      this.db
        .prepare(`UPDATE attempts SET score = ?, is_correct = ?, grade_status = ?, rating = ?, srs_before = ? WHERE id = ?`)
        .run(score, score >= 0.8 ? 1 : 0, g.grader === 'self' ? 'self' : 'graded', rating, srsBefore, attemptId);
      return { attempt_id: attemptId, score, rating, schedule_updated: !newer };
    });
  }

  pendingGrades(limit = 20) {
    const rows = this.db
      .prepare(`SELECT a.id, a.question_id, a.response, a.answered_at, a.time_ms FROM attempts a WHERE grade_status = 'pending' ORDER BY a.id LIMIT ?`)
      .all(limit) as any[];
    const qs = new Map(this.q.getMany([...new Set(rows.map((r) => r.question_id))]).map((q) => [q.id, q]));
    return rows.map((r) => {
      const q = qs.get(r.question_id)!;
      return {
        attempt_id: r.id,
        question_id: q.id,
        prompt: q.prompt,
        type: q.type,
        language: q.type === 'code' ? q.spec.language : undefined,
        model_answer: q.spec.model_answer ?? q.spec.reference_solution,
        rubric: q.spec.rubric ?? null,
        explanation: q.explanation,
        tags: q.tags.map((t) => t.path),
        response: JSON.parse(r.response).text ?? JSON.parse(r.response).code,
        answered_at: r.answered_at,
        time_ms: r.time_ms,
      };
    });
  }
}

export { Rating };
export type { Question };
