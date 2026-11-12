import { type DB, now } from './db.ts';
import { studyDay, endOfStudyDay, limits, cardRetrievability } from './srs.ts';
import type { Tags } from './tags.ts';
import { clozeParts } from './qtypes.ts';

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
      weak: this.tagMastery({ minAttempts: 3 }).filter((t) => t.leaf).slice(0, 5),
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
      else if (r.type === 'matching') {
        const rights = [...spec.pairs.map((p: any) => p.right), ...(spec.distractors ?? [])];
        given = spec.pairs.map((p: any, i: number) => `${p.left} → ${resp.map[i] == null ? '(none)' : rights[resp.map[i]]}`);
        expected = spec.pairs.map((p: any) => `${p.left} → ${p.right}`);
      } else if (r.type === 'ordering') { given = resp.order.map((i: number) => spec.items[i]); expected = spec.items; }
      else if (r.type === 'cloze') { given = resp.blanks; expected = clozeParts(r.prompt).map((p) => p.accept); }
      else if (r.type === 'code') { given = resp.code; expected = spec.reference_solution ?? `${spec.tests?.length ?? 0} tests`; }
      else if (r.type === 'hotspot') { given = { x: resp.x, y: resp.y }; expected = spec.regions; }
      return {
        attempt_id: r.attempt_id, question_id: r.question_id, type: r.type, tags: r.tags?.split(', ') ?? [], prompt: r.prompt,
        given, expected, score: r.score, confidence: r.confidence, time_ms: r.time_ms, feedback: r.feedback ?? undefined,
      };
    });
  }

  /** Mastery per tag from the calibration engine, with recent accuracy and trend. */
  tagMastery(opts: { minAttempts?: number } = {}) {
    const day = 864e5, t = now();
    const rows = this.db
      .prepare(
        `SELECT t.id, t.path, t.name, a.theta, a.n,
           (SELECT AVG(x.score) FROM attempts x JOIN question_tags qt ON qt.question_id = x.question_id WHERE qt.tag_id = t.id AND x.score IS NOT NULL AND x.answered_at >= ?) recent_acc,
           (SELECT AVG(x.score) FROM attempts x JOIN question_tags qt ON qt.question_id = x.question_id WHERE qt.tag_id = t.id AND x.score IS NOT NULL AND x.answered_at >= ? AND x.answered_at < ?) prior_acc,
           (SELECT AVG(x.time_ms) FROM attempts x JOIN question_tags qt ON qt.question_id = x.question_id WHERE qt.tag_id = t.id AND x.score IS NOT NULL) avg_ms,
           (SELECT COUNT(*) FROM attempts x JOIN question_tags qt ON qt.question_id = x.question_id WHERE qt.tag_id = t.id AND x.is_correct = 0 AND x.confidence >= 3 AND x.answered_at >= ?) confident_wrong,
           NOT EXISTS (SELECT 1 FROM tags c WHERE c.parent_id = t.id AND c.merged_into_id IS NULL) leaf
         FROM ability a JOIN tags t ON t.id = a.tag_id WHERE t.merged_into_id IS NULL AND a.n >= ? ORDER BY a.theta ASC`,
      )
      .all(t - 14 * day, t - 28 * day, t - 14 * day, t - 30 * day, opts.minAttempts ?? 1) as any[];
    return rows.map((r) => ({
      id: r.id, path: r.path, name: r.name, attempts: r.n,
      mastery: +(1 / (1 + Math.exp(-r.theta))).toFixed(3),
      recent_accuracy: r.recent_acc == null ? null : +r.recent_acc.toFixed(3),
      trend: r.recent_acc != null && r.prior_acc != null ? +(r.recent_acc - r.prior_acc).toFixed(3) : null,
      avg_ms: r.avg_ms == null ? null : Math.round(r.avg_ms),
      confident_wrong: r.confident_wrong,
      leaf: !!r.leaf,
    }));
  }

  /** "Study next" suggestions, each with a ready-to-run session config. */
  recommendations(limit = 6) {
    const out: { kind: string; title: string; reason: string; session?: Record<string, unknown>; agent_prompt?: string }[] = [];
    const h = this.home();
    if (h.due + h.new_available > 0)
      out.push({ kind: 'review', title: `Review ${h.due + h.new_available} questions`, reason: `${h.due} due today${h.new_available ? `, ${h.new_available} new` : ''}. Keeps your schedule on track.`, session: { mode: 'srs' } });
    const mastery = this.tagMastery({ minAttempts: 3 });
    const leaves = new Set((this.db.prepare(`SELECT path FROM tags t WHERE merged_into_id IS NULL AND NOT EXISTS (SELECT 1 FROM tags c WHERE c.parent_id = t.id AND c.merged_into_id IS NULL)`).all() as { path: string }[]).map((r) => r.path));
    const weakLeaves = mastery.filter((m) => leaves.has(m.path) && m.mastery < 0.7).slice(0, 2);
    for (const w of weakLeaves)
      out.push({ kind: 'weak', title: `Strengthen ${w.name}`, reason: `Mastery ${Math.round(w.mastery * 100)}% over ${w.attempts} answers${w.trend != null && w.trend < 0 ? ', and slipping' : ''}.`, session: { mode: 'weak', tags: [w.path], limit: 15 } });
    const over = mastery.filter((m) => m.confident_wrong >= 2).sort((a, b) => b.confident_wrong - a.confident_wrong)[0];
    if (over && !weakLeaves.some((w) => w.id === over.id))
      out.push({ kind: 'overconfident', title: `Recheck ${over.name}`, reason: `${over.confident_wrong} answers this month where you were sure but wrong. Likely a misconception.`, session: { mode: 'practice', tags: [over.path], limit: 10 } });
    // Decaying: reviewed tags whose average recall has dropped, before they come due.
    const at = now();
    const decay = (this.db
      .prepare(`SELECT t.path, t.name, c.card FROM srs_cards c JOIN question_tags qt ON qt.question_id = c.question_id JOIN tags t ON t.id = qt.tag_id WHERE c.due > ?`)
      .all(at) as { path: string; name: string; card: string }[]).reduce((m, r) => {
        const e = m.get(r.path) ?? { name: r.name, sum: 0, n: 0 };
        e.sum += cardRetrievability(JSON.parse(r.card), at);
        e.n++;
        return m.set(r.path, e);
      }, new Map<string, { name: string; sum: number; n: number }>());
    const fading = [...decay].filter(([, e]) => e.n >= 3 && e.sum / e.n < 0.88).sort((a, b) => a[1].sum / a[1].n - b[1].sum / b[1].n)[0];
    if (fading)
      out.push({ kind: 'fading', title: `Refresh ${fading[1].name}`, reason: `Estimated recall is down to ${Math.round((fading[1].sum / fading[1].n) * 100)}%. A short session now saves relearning later.`, session: { mode: 'adaptive', tags: [fading[0]], limit: 10 } });
    const untouched = this.db
      .prepare(
        `SELECT t.path, t.name, COUNT(*) n FROM tags t JOIN question_tags qt ON qt.tag_id = t.id JOIN questions q ON q.id = qt.question_id
         WHERE q.status = 'active' AND t.merged_into_id IS NULL AND NOT EXISTS (SELECT 1 FROM attempts a JOIN question_tags q2 ON q2.question_id = a.question_id WHERE q2.tag_id = t.id)
         GROUP BY t.id ORDER BY n DESC LIMIT 1`,
      )
      .get() as { path: string; name: string; n: number } | undefined;
    if (untouched) out.push({ kind: 'new', title: `Start ${untouched.name}`, reason: `${untouched.n} questions you have never seen.`, session: { mode: 'practice', tags: [untouched.path], limit: 10 } });
    const thin = weakLeaves.map((w) => ({ w, n: (this.db.prepare(`SELECT COUNT(*) n FROM question_tags qt JOIN questions q ON q.id = qt.question_id WHERE qt.tag_id = ? AND q.status = 'active'`).get(w.id) as { n: number }).n })).find((x) => x.n < 8);
    if (thin)
      out.push({ kind: 'agent', title: `More questions on ${thin.w.name}`, reason: `Only ${thin.n} questions for a weak tag. Ask your agent to write targeted ones.`, agent_prompt: `Look at my recent mistakes in Socrates under "${thin.w.path}" and add 8 new questions that target them, mixing types and difficulties.` });
    return out.slice(0, limit);
  }

  /** Everything the analytics dashboard needs, optionally limited to a tag subtree. */
  analytics(opts: { days?: number; tag?: string } = {}) {
    const days = opts.days ?? 90;
    const since = now() - days * 864e5;
    let filter = '';
    if (opts.tag) {
      const r = this.tags.resolve(opts.tag);
      if (r.tag_id) filter = `AND a.question_id IN (SELECT question_id FROM question_tags WHERE tag_id IN (${this.tags.descendantIds(r.tag_id).join(',')}))`;
    }
    const base = `FROM attempts a JOIN questions q ON q.id = a.question_id WHERE a.score IS NOT NULL AND a.answered_at >= ${since} ${filter}`;
    const all = <T,>(sql: string) => this.db.prepare(sql).all() as T[];
    const r3 = (x: number | null) => (x == null ? null : +x.toFixed(3));
    const totals = this.db.prepare(`SELECT COUNT(*) n, AVG(a.score) acc, SUM(a.time_ms) time_ms, COUNT(DISTINCT a.study_day) days, AVG(a.hints_used > 0) hint_rate ${base}`).get() as any;
    const daily = all<any>(`SELECT a.study_day day, COUNT(*) n, AVG(a.score) acc, AVG(a.time_ms) avg_ms ${base} GROUP BY a.study_day ORDER BY day`);
    const byType = all<any>(`SELECT q.type k, COUNT(*) n, AVG(a.score) acc, AVG(a.time_ms) avg_ms ${base} GROUP BY q.type ORDER BY acc`);
    const byDifficulty = all<any>(`SELECT q.difficulty k, COUNT(*) n, AVG(a.score) acc, AVG(a.time_ms) avg_ms ${base} GROUP BY q.difficulty ORDER BY k`);
    const byHour = all<any>(`SELECT a.local_hour k, COUNT(*) n, AVG(a.score) acc ${base} GROUP BY a.local_hour ORDER BY k`);
    const confidence = all<any>(`SELECT a.confidence k, COUNT(*) n, AVG(a.score) acc ${base} AND a.confidence IS NOT NULL GROUP BY a.confidence ORDER BY k`);
    // Forgetting: predicted recall (FSRS) vs actual, and actual recall by days since last review.
    const calibration = all<any>(`SELECT MIN(9, CAST(a.r_pred * 10 AS INT)) k, COUNT(*) n, AVG(a.r_pred) predicted, AVG(a.score >= 0.8) actual ${base} AND a.r_pred IS NOT NULL GROUP BY k ORDER BY k`);
    const retention = all<any>(
      `SELECT CASE WHEN a.elapsed_days < 1 THEN 0 WHEN a.elapsed_days < 3 THEN 1 WHEN a.elapsed_days < 7 THEN 2 WHEN a.elapsed_days < 14 THEN 3 WHEN a.elapsed_days < 30 THEN 4 WHEN a.elapsed_days < 90 THEN 5 ELSE 6 END k,
         COUNT(*) n, AVG(a.score >= 0.8) actual, AVG(a.r_pred) predicted ${base} AND a.elapsed_days IS NOT NULL GROUP BY k ORDER BY k`,
    );
    const hesitation = all<any>(
      `SELECT CASE WHEN a.first_input_ms < 2000 THEN 0 WHEN a.first_input_ms < 5000 THEN 1 WHEN a.first_input_ms < 10000 THEN 2 WHEN a.first_input_ms < 20000 THEN 3 ELSE 4 END k,
         COUNT(*) n, AVG(a.score) acc ${base} AND a.first_input_ms IS NOT NULL GROUP BY k ORDER BY k`,
    );
    const changes = all<any>(`SELECT MIN(a.answer_changes, 3) k, COUNT(*) n, AVG(a.score) acc ${base} GROUP BY k ORDER BY k`);
    const speed = all<any>(
      `SELECT t.path, t.name, COUNT(*) n, AVG(a.score) acc, AVG(a.time_ms) avg_ms ${base.replace('WHERE', 'JOIN question_tags qt ON qt.question_id = a.question_id JOIN tags t ON t.id = qt.tag_id WHERE')}
       GROUP BY t.id HAVING n >= 2 ORDER BY n DESC LIMIT 40`,
    );
    const fix = (rows: any[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? r3(v) : v])));
    return {
      window_days: days,
      totals: { attempts: totals.n, accuracy: r3(totals.acc), time_ms: totals.time_ms ?? 0, days: totals.days, hint_rate: r3(totals.hint_rate), streak: this.streak() },
      daily: fix(daily), by_type: fix(byType), by_difficulty: fix(byDifficulty), by_hour: fix(byHour), confidence: fix(confidence),
      calibration: fix(calibration), retention: fix(retention), hesitation: fix(hesitation), changes: fix(changes), speed: fix(speed),
      mastery: this.tagMastery(),
    };
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
