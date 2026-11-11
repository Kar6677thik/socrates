import { type DB, now } from './db.ts';
import { studyDay, endOfStudyDay, limits } from './srs.ts';
import type { Tags } from './tags.ts';

export class Stats {
  db: DB;
  tags: Tags;
  constructor(db: DB, tags: Tags) {
    this.db = db;
    this.tags = tags;
  }

  streak(at = now()): { current: number; best: number } {
    const days = (this.db.prepare('SELECT DISTINCT study_day d FROM attempts ORDER BY d DESC').all() as { d: string }[]).map((r) => r.d);
    if (!days.length) return { current: 0, best: 0 };
    const set = new Set(days);
    const dayMs = 864e5;
    let current = 0;
    let cursor = at;
    if (!set.has(studyDay(cursor))) cursor -= dayMs; // today not studied yet: streak still alive from yesterday
    while (set.has(studyDay(cursor))) { current++; cursor -= dayMs; }
    let best = 0, run = 0, prev: number | null = null;
    for (const d of [...days].reverse()) {
      const t = new Date(d + 'T12:00:00').getTime();
      run = prev !== null && Math.round((t - prev) / dayMs) === 1 ? run + 1 : 1;
      best = Math.max(best, run);
      prev = t;
    }
    return { current, best };
  }

  home(at = now()) {
    const lim = limits(this.db);
    const day = studyDay(at);
    const active = `q.status = 'active' AND q.flagged_reason IS NULL`;
    const due = (this.db.prepare(`SELECT COUNT(*) n FROM srs_cards c JOIN questions q ON q.id = c.question_id WHERE ${active} AND c.due <= ?`).get(endOfStudyDay(at)) as { n: number }).n;
    const unseen = (this.db.prepare(`SELECT COUNT(*) n FROM questions q WHERE ${active} AND q.id NOT IN (SELECT question_id FROM srs_cards)`).get() as { n: number }).n;
    const today = this.db
      .prepare(`SELECT COUNT(*) n, AVG(score) acc, SUM(time_ms) t, SUM(CASE WHEN srs_before IS NULL AND rating IS NOT NULL THEN 1 ELSE 0 END) fresh FROM attempts WHERE study_day = ?`)
      .get(day) as { n: number; acc: number | null; t: number | null; fresh: number | null };
    const counts = this.db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM questions WHERE status = 'active') active,
          (SELECT COUNT(*) FROM questions WHERE status = 'draft') drafts,
          (SELECT COUNT(*) FROM questions WHERE flagged_reason IS NOT NULL AND status != 'archived') flagged,
          (SELECT COUNT(*) FROM attempts WHERE grade_status = 'pending') pending,
          (SELECT COUNT(*) FROM tags WHERE merged_into_id IS NULL) tags`,
      )
      .get() as Record<string, number>;
    const since = at - 120 * 864e5;
    const calendar = this.db
      .prepare(`SELECT study_day day, COUNT(*) n, AVG(score) acc FROM attempts WHERE answered_at >= ? GROUP BY study_day ORDER BY study_day`)
      .all(since);
    return {
      due,
      new_available: Math.min(unseen, Math.max(0, lim.new_per_day - (today.fresh ?? 0))),
      unseen,
      today: { answered: today.n, accuracy: today.acc, time_ms: today.t ?? 0 },
      streak: this.streak(at),
      counts,
      calendar,
      weak: this.weakTags(5),
      limits: lim,
    };
  }

  /** Tags with the lowest recent accuracy (min attempts), including subtree rollup. */
  weakTags(limit = 10, minAttempts = 3, windowDays = 60) {
    const since = now() - windowDays * 864e5;
    const rows = this.db
      .prepare(
        `SELECT t.id, t.path, t.name, COUNT(a.id) attempts, AVG(a.score) accuracy, AVG(a.time_ms) avg_ms,
           SUM(CASE WHEN a.is_correct = 0 AND a.confidence >= 3 THEN 1 ELSE 0 END) confident_wrong,
           MAX(a.answered_at) last_seen
         FROM tags t JOIN question_tags qt ON qt.tag_id = t.id JOIN attempts a ON a.question_id = qt.question_id
         WHERE t.merged_into_id IS NULL AND a.score IS NOT NULL AND a.answered_at >= ?
         GROUP BY t.id HAVING attempts >= ? ORDER BY accuracy ASC, attempts DESC LIMIT ?`,
      )
      .all(since, minAttempts, limit) as any[];
    return rows.map((r) => ({ ...r, accuracy: +r.accuracy.toFixed(3), avg_ms: Math.round(r.avg_ms) }));
  }

  /** Performance overview for agents: overall, by tag (optionally under a subtree), type and difficulty. */
  performance(opts: { tag?: string; days?: number } = {}) {
    const days = opts.days ?? 90;
    const since = now() - days * 864e5;
    let tagFilter = '';
    const args: any[] = [since];
    if (opts.tag) {
      const r = this.tags.resolve(opts.tag);
      if (!r.tag_id) return { error: `Tag "${opts.tag}" not found`, suggestions: r.suggestions };
      const ids = this.tags.descendantIds(r.tag_id);
      tagFilter = `AND a.question_id IN (SELECT question_id FROM question_tags WHERE tag_id IN (${ids.join(',')}))`;
    }
    const base = `FROM attempts a JOIN questions q ON q.id = a.question_id WHERE a.score IS NOT NULL AND a.answered_at >= ? ${tagFilter}`;
    const overall = this.db
      .prepare(
        `SELECT COUNT(*) attempts, AVG(a.score) accuracy, AVG(a.time_ms) avg_ms, AVG(a.hints_used > 0) hint_rate,
          AVG(a.answer_changes) avg_changes, AVG(a.first_input_ms) avg_hesitation_ms ${base}`,
      )
      .get(...args);
    const byType = this.db.prepare(`SELECT q.type, COUNT(*) attempts, AVG(a.score) accuracy, AVG(a.time_ms) avg_ms ${base} GROUP BY q.type`).all(...args);
    const byDifficulty = this.db.prepare(`SELECT q.difficulty, COUNT(*) attempts, AVG(a.score) accuracy ${base} GROUP BY q.difficulty ORDER BY q.difficulty`).all(...args);
    const byTag = this.db
      .prepare(
        `SELECT t.path, COUNT(*) attempts, AVG(a.score) accuracy, AVG(a.time_ms) avg_ms,
           SUM(CASE WHEN a.is_correct = 0 AND a.confidence >= 3 THEN 1 ELSE 0 END) confident_wrong
         ${base.replace('WHERE', 'JOIN question_tags qt ON qt.question_id = a.question_id JOIN tags t ON t.id = qt.tag_id WHERE')}
         GROUP BY t.id ORDER BY accuracy ASC LIMIT 40`,
      )
      .all(...args);
    const calibration = this.db
      .prepare(`SELECT a.confidence, COUNT(*) attempts, AVG(a.score) accuracy ${base} AND a.confidence IS NOT NULL GROUP BY a.confidence`)
      .all(...args);
    const srs = this.db
      .prepare(`SELECT COUNT(*) cards, SUM(lapses) lapses, AVG(json_extract(card, '$.stability')) avg_stability_days, SUM(CASE WHEN due <= ? THEN 1 ELSE 0 END) due_now FROM srs_cards`)
      .get(now());
    const round = (o: any) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? +v.toFixed(3) : v]));
    return {
      window_days: days,
      overall: round(overall),
      by_type: byType.map(round),
      by_difficulty: byDifficulty.map(round),
      by_tag: byTag.map(round),
      confidence_calibration: calibration.map(round),
      srs: round(srs),
    };
  }

  /** Recent wrong or partial answers with what was answered, so an agent can target misconceptions. */
  recentMistakes(opts: { tag?: string; limit?: number } = {}) {
    let tagFilter = '';
    if (opts.tag) {
      const r = this.tags.resolve(opts.tag);
      if (!r.tag_id) return [];
      tagFilter = `AND a.question_id IN (SELECT question_id FROM question_tags WHERE tag_id IN (${this.tags.descendantIds(r.tag_id).join(',')}))`;
    }
    const rows = this.db
      .prepare(
        `SELECT a.id attempt_id, a.question_id, q.type, q.prompt, q.spec, a.response, a.score, a.confidence, a.time_ms, a.answered_at,
           (SELECT feedback FROM grades g WHERE g.attempt_id = a.id ORDER BY g.id DESC LIMIT 1) feedback,
           (SELECT group_concat(t.path, ', ') FROM question_tags qt JOIN tags t ON t.id = qt.tag_id WHERE qt.question_id = q.id) tags
         FROM attempts a JOIN questions q ON q.id = a.question_id
         WHERE a.score IS NOT NULL AND a.score < 0.8 ${tagFilter} ORDER BY a.id DESC LIMIT ?`,
      )
      .all(opts.limit ?? 20) as any[];
    return rows.map((r) => {
      const spec = JSON.parse(r.spec);
      const resp = JSON.parse(r.response);
      let given: unknown = resp, expected: unknown = spec;
      if (r.type === 'mcq_single') { given = spec.options[resp.choice] ?? null; expected = spec.options[spec.correct]; }
      else if (r.type === 'mcq_multi') { given = resp.choices.map((i: number) => spec.options[i]); expected = spec.correct.map((i: number) => spec.options[i]); }
      else if (r.type === 'true_false') { given = resp.value; expected = spec.correct; }
      else if (r.type === 'fill_blank') { given = resp.blanks; expected = spec.blanks.map((b: any) => b.accept); }
      else if (r.type === 'numeric') { given = resp.value; expected = spec.answer; }
      else if (r.type === 'short_answer') { given = resp.text; expected = spec.model_answer; }
      else if (r.type === 'flashcard') { given = '(self-rated)'; expected = spec.back; }
      return {
        attempt_id: r.attempt_id, question_id: r.question_id, type: r.type, tags: r.tags?.split(', ') ?? [], prompt: r.prompt,
        given, expected, score: r.score, confidence: r.confidence, time_ms: r.time_ms, feedback: r.feedback ?? undefined,
      };
    });
  }

  /** Tags with few questions or a narrow difficulty spread: where new questions help most. */
  coverageGaps(limit = 20) {
    return this.db
      .prepare(
        `SELECT t.path, COUNT(q.id) questions, COUNT(DISTINCT q.difficulty) difficulty_levels, COUNT(DISTINCT q.type) types,
           MIN(q.difficulty) min_difficulty, MAX(q.difficulty) max_difficulty
         FROM tags t LEFT JOIN question_tags qt ON qt.tag_id = t.id LEFT JOIN questions q ON q.id = qt.question_id AND q.status = 'active'
         WHERE t.merged_into_id IS NULL AND NOT EXISTS (SELECT 1 FROM tags c WHERE c.parent_id = t.id AND c.merged_into_id IS NULL)
         GROUP BY t.id ORDER BY questions ASC, difficulty_levels ASC LIMIT ?`,
      )
      .all(limit);
  }
}
