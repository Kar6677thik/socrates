import { z } from 'zod';
import { type DB, tx, now } from './db.ts';
import { Questions, type Question } from './questions.ts';
import { QTYPES, type QType, autoGrade, RESPONSES, AUTO_GRADED } from './qtypes.ts';
import { studyDay, endOfStudyDay, limits, review, deriveRating, baselineMs, cardRetrievability, Rating } from './srs.ts';

export const SessionConfig = z.object({
  mode: z.enum(['srs', 'practice']).default('srs'),
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
  events: z.array(z.object({ t: z.number(), kind: z.string(), data: z.unknown().optional() })).max(500).optional(),
});
export type AttemptInput = z.infer<typeof AttemptInput>;

const SELF_RATING_SCORE = { 1: 0, 2: 0.6, 3: 0.9, 4: 1 } as const;

export class Study {
  db: DB;
  q: Questions;
  constructor(db: DB, q: Questions) {
    this.db = db;
    this.q = q;
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
    const pool = this.pool(c);
    if (!pool.length) return [];
    const inPool = pool.join(',');
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
    const due = (this.db
      .prepare(`SELECT question_id, card FROM srs_cards WHERE due <= ? AND question_id IN (${inPool})`)
      .all(horizon) as { question_id: number; card: string }[])
      .map((r) => ({ id: r.question_id, r: cardRetrievability(JSON.parse(r.card), at) }))
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
    return { session_id: Number(info.lastInsertRowid), mode: c.mode, questions: qs.map((x) => this.q.toPublic(x)) };
  }

  /** Remaining (unanswered) questions of an existing session, e.g. one an agent created. */
  loadSession(id: number) {
    const s = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!s) throw new Error(`Session ${id} not found.`);
    const done = new Set((this.db.prepare('SELECT question_id FROM attempts WHERE session_id = ?').all(id) as { question_id: number }[]).map((r) => r.question_id));
    const queue = (JSON.parse(s.queue) as number[]).filter((qid) => !done.has(qid));
    const qs = this.q.getMany(queue).filter((q) => q.status === 'active');
    return { session_id: id, mode: s.mode, answered: done.size, ended: !!s.ended_at, questions: qs.map((x) => this.q.toPublic(x)) };
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
  submit(input: unknown) {
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
      if (AUTO_GRADED.includes(q.type)) {
        const g = autoGrade(q.type, q.spec, resp.data)!;
        score = g.score; correct = g.correct; detail = g.detail; gradeStatus = 'auto';
      } else if (q.type === 'flashcard') {
        const r = (a.self_rating ?? 3) as 1 | 2 | 3 | 4;
        score = SELF_RATING_SCORE[r]; correct = r >= 3; gradeStatus = 'self';
      } else if (a.self_score !== undefined) {
        score = a.self_score; correct = a.self_score >= 0.8; gradeStatus = 'self';
      } else {
        gradeStatus = 'pending';
      }

      let rating: number | null = null;
      let srs: ReturnType<typeof review> | null = null;
      if (score !== null) {
        rating = q.type === 'flashcard' && a.self_rating
          ? a.self_rating
          : deriveRating({ score, time_ms: a.time_ms, confidence: a.confidence, hints_used: a.hints_used, baseline_ms: baselineMs(this.db, q.id, q.type) });
        srs = review(this.db, q.id, rating as any, at);
      }
      const shown = new Date(a.shown_at);
      const info = this.db
        .prepare(
          `INSERT INTO attempts(question_id, question_version, session_id, response, is_correct, score, grade_status, confidence,
             hints_used, time_ms, first_input_ms, answer_changes, shown_at, answered_at, local_hour, weekday, study_day, rating, srs_before)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          q.id, q.version, a.session_id ?? null, JSON.stringify(resp.data), correct === null ? null : correct ? 1 : 0, score, gradeStatus,
          a.confidence ?? null, a.hints_used, a.time_ms, a.first_input_ms ?? null, a.answer_changes, a.shown_at, at,
          shown.getHours(), shown.getDay(), studyDay(a.shown_at), rating, srs?.before ?? null,
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
        answer: q.spec,
        explanation: q.explanation,
      };
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
        model_answer: q.spec.model_answer,
        rubric: q.spec.rubric ?? null,
        explanation: q.explanation,
        tags: q.tags.map((t) => t.path),
        response: JSON.parse(r.response).text,
        answered_at: r.answered_at,
        time_ms: r.time_ms,
      };
    });
  }
}

export { Rating };
export type { Question };
