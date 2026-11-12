import { type DB, now, idSet } from './db.ts';

/**
 * Elo/IRT-style calibration (1-parameter logistic):
 *   P(correct) = sigmoid(theta_tags - b_question)
 * After each graded attempt, tag abilities move toward the result and the question's
 * difficulty moves the other way. Step sizes shrink as evidence accumulates.
 * Leaf tags get full weight, ancestors half, so mastery rolls up the tree.
 */

export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
/** Seed difficulty 1..5 -> initial b. */
export const prior = (difficulty: number) => (difficulty - 3) * 0.7;
/** Calibrated b -> 1..5 scale for display. */
export const bToLevel = (b: number) => Math.max(1, Math.min(5, b / 0.7 + 3));

interface TagW { id: number; w: number }
export interface EngineBefore {
  b: number | null;
  n: number;
  tags: { id: number; theta: number; n: number; existed: boolean }[];
}

export class Engine {
  db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  /** Leaf tags of the question at weight 1, their ancestors at 0.5. */
  tagWeights(questionId: number): TagW[] {
    const rows = this.db
      .prepare('SELECT t.id, t.path FROM question_tags qt JOIN tags t ON t.id = qt.tag_id WHERE qt.question_id = ?')
      .all(questionId) as { id: number; path: string }[];
    const out = new Map<number, number>();
    for (const r of rows) out.set(r.id, 1);
    const anc = this.db.prepare('SELECT id FROM tags WHERE path = ? AND merged_into_id IS NULL');
    for (const r of rows) {
      const parts = r.path.split('/');
      for (let i = parts.length - 1; i > 0; i--) {
        const a = anc.get(parts.slice(0, i).join('/')) as { id: number } | undefined;
        if (a && !out.has(a.id)) out.set(a.id, 0.5);
      }
    }
    return [...out].map(([id, w]) => ({ id, w }));
  }

  private ability(ids: number[]) {
    if (!ids.length) return new Map<number, { theta: number; n: number }>();
    const rows = this.db.prepare(`SELECT tag_id, theta, n FROM ability WHERE tag_id IN (${ids.join(',')})`).all() as { tag_id: number; theta: number; n: number }[];
    return new Map(rows.map((r) => [r.tag_id, { theta: r.theta, n: r.n }]));
  }

  /** Weighted ability over the question's tags (tags with no data count as 0). */
  private theta(tags: TagW[], ab: Map<number, { theta: number; n: number }>) {
    let s = 0, w = 0;
    for (const t of tags) {
      const a = ab.get(t.id);
      // Weight by evidence too, so a well-measured tag dominates an untested one.
      const ww = t.w * (0.3 + Math.min(1, (a?.n ?? 0) / 10));
      s += (a?.theta ?? 0) * ww;
      w += ww;
    }
    return w ? s / w : 0;
  }

  private qb(questionId: number): { b: number; n: number; raw: number | null } {
    const q = this.db.prepare('SELECT difficulty, irt_b, irt_n FROM questions WHERE id = ?').get(questionId) as { difficulty: number; irt_b: number | null; irt_n: number };
    return { b: q.irt_b ?? prior(q.difficulty), n: q.irt_n, raw: q.irt_b };
  }

  predict(questionId: number): number {
    const tags = this.tagWeights(questionId);
    return sigmoid(this.theta(tags, this.ability(tags.map((t) => t.id))) - this.qb(questionId).b);
  }

  /** Predicted P(correct) for many questions in one pass. */
  predictMany(ids: number[]): Map<number, number> {
    const out = new Map<number, number>();
    if (!ids.length) return out;
    const src = ids.length > 200 ? idSet(this.db, 'engine_ids', ids) : ids.join(',');
    const qs = this.db.prepare(`SELECT id, difficulty, irt_b FROM questions WHERE id IN (${src})`).all() as { id: number; difficulty: number; irt_b: number | null }[];
    const qt = this.db.prepare(`SELECT question_id, tag_id FROM question_tags WHERE question_id IN (${src})`).all() as { question_id: number; tag_id: number }[];
    const ab = new Map((this.db.prepare('SELECT tag_id, theta, n FROM ability').all() as { tag_id: number; theta: number; n: number }[]).map((r) => [r.tag_id, r]));
    // Each tag's weights (itself 1, ancestors 0.5), worked out once per tag rather than per question.
    const tags = this.db.prepare('SELECT id, path FROM tags WHERE merged_into_id IS NULL').all() as { id: number; path: string }[];
    const pathId = new Map(tags.map((r) => [r.path, r.id]));
    const own = new Map<number, TagW[]>();
    for (const t of tags) {
      const parts = t.path.split('/');
      const list: TagW[] = [{ id: t.id, w: 1 }];
      for (let i = parts.length - 1; i > 0; i--) {
        const a = pathId.get(parts.slice(0, i).join('/'));
        if (a) list.push({ id: a, w: 0.5 });
      }
      own.set(t.id, list);
    }
    const byQ = new Map<number, Map<number, number>>();
    for (const r of qt) {
      let m = byQ.get(r.question_id);
      if (!m) byQ.set(r.question_id, (m = new Map()));
      for (const tw of own.get(r.tag_id) ?? []) if ((m.get(tw.id) ?? 0) < tw.w) m.set(tw.id, tw.w);
    }
    const tagsOf = (id: number): TagW[] => [...(byQ.get(id) ?? [])].map(([tid, w]) => ({ id: tid, w }));
    for (const q of qs) out.set(q.id, sigmoid(this.theta(tagsOf(q.id), ab) - (q.irt_b ?? prior(q.difficulty))));
    return out;
  }

  /** Apply a graded result. Returns the prediction made before the update and the prior state (for undo). */
  update(questionId: number, score: number): { p: number; before: EngineBefore } {
    const tags = this.tagWeights(questionId);
    const ab = this.ability(tags.map((t) => t.id));
    const q = this.qb(questionId);
    const theta = this.theta(tags, ab);
    const p = sigmoid(theta - q.b);
    const err = score - p;
    const before: EngineBefore = {
      b: q.raw, n: q.n,
      tags: tags.map((t) => ({ id: t.id, theta: ab.get(t.id)?.theta ?? 0, n: ab.get(t.id)?.n ?? 0, existed: ab.has(t.id) })),
    };
    const up = this.db.prepare(
      `INSERT INTO ability(tag_id, theta, n, updated_at) VALUES(?,?,?,?)
       ON CONFLICT(tag_id) DO UPDATE SET theta = excluded.theta, n = excluded.n, updated_at = excluded.updated_at`,
    );
    for (const t of tags) {
      const a = ab.get(t.id) ?? { theta: 0, n: 0 };
      const k = Math.max(0.06, 0.6 / (1 + a.n / 8)) * t.w;
      up.run(t.id, clamp(a.theta + k * err, -4, 4), a.n + 1, now());
    }
    const kb = Math.max(0.05, 0.5 / (1 + q.n / 5));
    this.db.prepare('UPDATE questions SET irt_b = ?, irt_n = irt_n + 1 WHERE id = ?').run(clamp(q.b - kb * err, -4, 4), questionId);
    return { p, before };
  }

  /** Correct a past result in place (grade override) without replaying history. */
  adjust(questionId: number, deltaScore: number) {
    if (!deltaScore) return;
    const tags = this.tagWeights(questionId);
    const ab = this.ability(tags.map((t) => t.id));
    for (const t of tags) {
      const a = ab.get(t.id);
      if (!a) continue;
      const k = Math.max(0.06, 0.6 / (1 + a.n / 8)) * t.w;
      this.db.prepare('UPDATE ability SET theta = ? WHERE tag_id = ?').run(clamp(a.theta + k * deltaScore, -4, 4), t.id);
    }
    const q = this.qb(questionId);
    const kb = Math.max(0.05, 0.5 / (1 + q.n / 5));
    this.db.prepare('UPDATE questions SET irt_b = ? WHERE id = ?').run(clamp(q.b - kb * deltaScore, -4, 4), questionId);
  }

  restore(questionId: number, before: EngineBefore) {
    this.db.prepare('UPDATE questions SET irt_b = ?, irt_n = ? WHERE id = ?').run(before.b, before.n, questionId);
    for (const t of before.tags) {
      if (t.existed) this.db.prepare('UPDATE ability SET theta = ?, n = ? WHERE tag_id = ?').run(t.theta, t.n, t.id);
      else this.db.prepare('DELETE FROM ability WHERE tag_id = ?').run(t.id);
    }
  }

  /** Mastery per tag: P(correct) on a question of average difficulty. */
  mastery(): Map<number, { mastery: number; theta: number; n: number }> {
    const rows = this.db.prepare('SELECT tag_id, theta, n FROM ability').all() as { tag_id: number; theta: number; n: number }[];
    return new Map(rows.map((r) => [r.tag_id, { mastery: sigmoid(r.theta), theta: r.theta, n: r.n }]));
  }
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
