import { z } from 'zod';
import { type DB, tx, now, getSetting } from './db.ts';
import { Tags, type Suggestion } from './tags.ts';
import { SPECS, QTYPES, type QType, checkSpec, answerKey, searchBody, publicSpec, clozeParts, clozePublicPrompt } from './qtypes.ts';
import { contentHash, textVector, cosine, ftsQuery, searchWords, normalizeText } from './text.ts';
import { embed, embedText, toBlob, fromBlob, dot } from './embed.ts';

export const DUPLICATE_THRESHOLD = 0.92;
export const NEAR_DUPLICATE_THRESHOLD = 0.85;
/**
 * Meaning-based matches never reject: embeddings score a statement and its converse
 * ("every square matrix is invertible" / "every invertible matrix is square") as close as a
 * paraphrase. So a meaning match only flags a possible duplicate, and only when answers agree.
 */
export const SEMANTIC_THRESHOLD = 0.85;
export const SEMANTIC_ANY_ANSWER = 0.95;

function coreAnswer(type: QType, spec: any): string {
  switch (type) {
    case 'mcq_single': return spec.options[spec.correct];
    case 'mcq_multi': return spec.correct.map((i: number) => spec.options[i]).sort().join(' ');
    case 'true_false': return String(spec.correct);
    case 'fill_blank': return spec.blanks.map((b: any) => b.accept[0]).join(' ');
    case 'numeric': return String(spec.answer);
    case 'short_answer': return spec.model_answer;
    case 'flashcard': return spec.back;
    case 'matching': return spec.pairs.map((p: any) => `${p.left} ${p.right}`).sort().join(' ');
    case 'ordering': return spec.items.join(' ');
    case 'cloze': return '';
    case 'code': return spec.reference_solution ?? '';
    case 'hotspot': return JSON.stringify(spec.regions);
  }
}

export function answersAgree(ta: QType, sa: any, tb: QType, sb: any): boolean {
  const a = normalizeText(coreAnswer(ta, sa)), b = normalizeText(coreAnswer(tb, sb));
  if (a === b) return true;
  if ((ta === 'true_false') !== (tb === 'true_false')) return false;
  return cosine(textVector(a), textVector(b)) >= 0.6;
}
export const MAX_BATCH = 100;

const SPEC_FIELDS = [...new Set(Object.values(SPECS).flatMap((s) => Object.keys(s.shape)))];

/**
 * Where a question came from in another app, the shared cross-app reference ({app, id, url, title}), e.g. the Slate
 * note or Sprawl card it was written from. `id` is the stable key (`note:<guid>`, `card:<id>`); `url` and `title` are
 * display hints captured when the question was made.
 */
export const SourceRef = z
  .object({
    app: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, 'lowercase app name, e.g. "slate"').describe('App the item lives in: slate, sprawl, …'),
    id: z.string().min(1).max(200).regex(/^\S+$/, 'no spaces').describe('Stable id in that app, e.g. "note:<guid>" for a Slate note'),
    url: z
      .string()
      .max(2000)
      .refine((u) => {
        try {
          const x = new URL(u);
          return x.protocol === 'https:' || (x.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(x.hostname));
        } catch {
          return false;
        }
      }, 'must be an absolute https URL')
      .optional()
      .describe("The item's own web address, copied exactly from that app's tool result"),
    title: z.string().max(300).optional().describe('Its title when the question was made'),
  })
  .strict();
export type SourceRef = z.infer<typeof SourceRef>;

/** Flat input shape: common fields + the type-specific fields for `type`. */
export const QuestionInput = z
  .object({
    type: z.enum(QTYPES as [QType, ...QType[]]),
    prompt: z.string().min(1).describe('Question text (markdown, LaTeX with $...$ / $$...$$, fenced code). fill_blank uses {{blank}} markers.'),
    tags: z.array(z.string().min(1)).min(1).max(12).describe('Tag paths like "math > calculus > integrals". Must already exist (see `resolve_tags` / `create_tags`).'),
    difficulty: z.number().int().min(1).max(5).optional().describe('1 easy .. 5 hard. Default 3.'),
    explanation: z.string().optional().describe('Shown after answering (markdown)'),
    hints: z.array(z.string()).max(5).optional(),
    source: z
      .union([SourceRef, z.string().max(500)])
      .optional()
      .describe('The item in another app this question was made from: {app, id, url, title}. (A plain string is taken as citation.)'),
    citation: z.string().max(500).optional().describe('Free-text source: book, chapter, lecture, web page'),
    group_id: z.string().optional().describe('Questions sharing a group are never shown back to back'),
    client_ref: z.string().max(200).optional().describe('Idempotency key. Retrying with the same key returns the existing question.'),
  })
  .passthrough();
export type QuestionInput = z.infer<typeof QuestionInput> & Record<string, unknown>;

export interface Question {
  id: number;
  type: QType;
  prompt: string;
  spec: any;
  explanation: string | null;
  hints: string[];
  difficulty: number;
  irt_b: number | null;
  /** Free-text source (book, lecture). Stored in the `source` column for historical reasons. */
  citation: string | null;
  /** Structured cross-app source, see SourceRef. */
  source: SourceRef | null;
  group_id: string | null;
  status: 'draft' | 'active' | 'suspended' | 'archived';
  flagged_reason: string | null;
  near_duplicate_of: number[] | null;
  version: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  tags: { id: number; path: string; name: string }[];
}

export type AddResult =
  | { index: number; status: 'created' | 'would_create'; id?: number; near_duplicates?: SimilarHit[]; question_status?: string }
  | { index: number; status: 'exists'; id: number; note: string }
  | { index: number; status: 'duplicate'; duplicate_of: SimilarHit[]; note: string }
  | { index: number; status: 'invalid'; errors: string[] }
  | { index: number; status: 'unresolved_tags'; tags: { input: string; missing: string[]; suggestions: Suggestion[] }[]; note: string };

export interface SimilarHit {
  id: number;
  similarity: number;
  prompt: string;
  /** wording = lexical overlap; meaning = embedding similarity with agreeing answers */
  match?: 'wording' | 'meaning';
}

function rowToQuestion(r: any, tags: Question['tags']): Question {
  const { source, source_ref, embedding, ...rest } = r;
  return {
    ...rest,
    citation: source ?? null,
    source: source_ref ? JSON.parse(source_ref) : null,
    spec: JSON.parse(r.spec),
    hints: JSON.parse(r.hints),
    near_duplicate_of: r.near_duplicate_of ? JSON.parse(r.near_duplicate_of) : null,
    tags,
  };
}

export class Questions {
  db: DB;
  tags: Tags;
  constructor(db: DB, tags: Tags) {
    this.db = db;
    this.tags = tags;
  }

  /** Split a flat input into common fields + validated spec. */
  validate(input: unknown): { ok: true; q: QuestionInput; spec: any } | { ok: false; errors: string[] } {
    // null means "not given" (the editor sends explanation: null for an empty box), never a value.
    const cleaned = input && typeof input === 'object' && !Array.isArray(input)
      ? Object.fromEntries(Object.entries(input).filter(([, v]) => v !== null))
      : input;
    const base = QuestionInput.safeParse(cleaned);
    if (!base.success) return { ok: false, errors: base.error.issues.map((i) => `${i.path.join('.') || 'item'}: ${i.message}`) };
    const q = base.data as QuestionInput;
    // Older clients and imports send `source` as text: that is a citation.
    if (typeof q.source === 'string') {
      if (q.citation === undefined && q.source.trim()) q.citation = q.source.trim();
      delete q.source;
    }
    const raw: Record<string, unknown> = {};
    for (const k of SPEC_FIELDS) if (k in q) raw[k] = q[k];
    const spec = SPECS[q.type].strict().safeParse(raw);
    if (!spec.success) {
      const allowed = Object.keys(SPECS[q.type].shape).join(', ');
      return { ok: false, errors: spec.error.issues.map((i) => `${i.path.join('.') || q.type}: ${i.message} (fields for ${q.type}: ${allowed})`) };
    }
    const cross = checkSpec(q.type, q.prompt, spec.data);
    if (cross) return { ok: false, errors: [cross] };
    return { ok: true, q, spec: spec.data };
  }

  private tagsFor(ids: number[]): Map<number, Question['tags']> {
    const out = new Map<number, Question['tags']>();
    if (!ids.length) return out;
    const rows = this.db
      .prepare(
        `SELECT qt.question_id, t.id, t.path, t.name FROM question_tags qt JOIN tags t ON t.id = qt.tag_id
         WHERE qt.question_id IN (${ids.map(() => '?').join(',')}) ORDER BY t.path`,
      )
      .all(...ids) as { question_id: number; id: number; path: string; name: string }[];
    for (const r of rows) {
      if (!out.has(r.question_id)) out.set(r.question_id, []);
      out.get(r.question_id)!.push({ id: r.id, path: r.path, name: r.name });
    }
    return out;
  }

  get(id: number): Question | undefined {
    const r = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
    if (!r) return undefined;
    return rowToQuestion(r, this.tagsFor([id]).get(id) ?? []);
  }

  getMany(ids: number[]): Question[] {
    if (!ids.length) return [];
    const rows = this.db.prepare(`SELECT * FROM questions WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    const tags = this.tagsFor(ids);
    const byId = new Map(rows.map((r: any) => [r.id, rowToQuestion(r, tags.get(r.id) ?? [])]));
    return ids.map((id) => byId.get(id)!).filter(Boolean);
  }

  /** What the quiz UI sees before answering: no answers. */
  toPublic(q: Question) {
    return {
      id: q.id,
      type: q.type,
      // Cloze answers live in the prompt itself, so they are swapped for blanks here.
      prompt: q.type === 'cloze' ? clozePublicPrompt(q.prompt) : q.prompt,
      spec: q.type === 'cloze' ? { blanks: clozeParts(q.prompt).length } : publicSpec(q.type, q.spec),
      hints: q.hints.length,
      difficulty: q.difficulty,
      group_id: q.group_id,
      tags: q.tags.map((t) => t.path),
      version: q.version,
    };
  }

  private probe: { clear: any; ins: any; stems: any; df: any } | null = null;
  /** word -> FTS stem (stems never change, so this only grows; reset if it gets large). */
  private stems = new Map<string, string>();
  private probeUses = 0;
  /**
   * stem -> documents containing it. Lookups cost ~0.1 ms inside a write transaction, so
   * counts are cached for a while; only the ranking of words depends on them. Zero is never
   * cached, so a word added moments ago (e.g. earlier in the same import) still counts.
   */
  private dfCache = new Map<string, number>();
  private dfAt = 0;
  private docFreq(stem: string): number {
    if (Date.now() - this.dfAt > 60_000 || this.dfCache.size > 100_000) { this.dfCache.clear(); this.dfAt = Date.now(); }
    const hit = this.dfCache.get(stem);
    if (hit !== undefined) return hit;
    const n = ((this.probe!.df.get(stem) as { doc: number } | undefined)?.doc ?? 0);
    if (n > 0) this.dfCache.set(stem, n);
    return n;
  }

  /**
   * FTS query for duplicate candidates: any two of the five rarest words that the library
   * already contains. A plain OR of words matched most of a large library, and ranking every
   * match made each duplicate check slower as the bank grew (25 ms per question at 10k).
   * A real duplicate shares nearly all of its words, so it contains at least two of these.
   * Stems come from FTS5 itself (a scratch table with the same tokenizer) so the document
   * counts line up with the index.
   */
  private rareMatch(text: string, max = 5): string {
    const words = searchWords(text).slice(0, 48);
    if (!words.length) return '';
    // FTS5 deletes leave tombstones behind, so the scratch table is rebuilt now and then.
    if (this.probe && ++this.probeUses > 300) {
      this.db.exec('DROP TABLE IF EXISTS temp.stem_probe_i; DROP TABLE IF EXISTS temp.stem_probe;');
      this.probe = null;
    }
    if (!this.probe) {
      this.probeUses = 0;
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.stem_probe USING fts5(w, tokenize='porter unicode61');
        CREATE VIRTUAL TABLE IF NOT EXISTS temp.stem_probe_i USING fts5vocab(temp, stem_probe, instance);
        CREATE VIRTUAL TABLE IF NOT EXISTS temp.questions_fts_v USING fts5vocab(main, questions_fts, row);`);
      this.probe = {
        clear: this.db.prepare('DELETE FROM temp.stem_probe'),
        ins: this.db.prepare('INSERT INTO temp.stem_probe(rowid, w) VALUES(?, ?)'),
        stems: this.db.prepare('SELECT term, doc FROM temp.stem_probe_i'),
        df: this.db.prepare('SELECT doc FROM temp.questions_fts_v WHERE term = ?'),
      };
    }
    const p = this.probe;
    const unknown = words.filter((w) => !this.stems.has(w));
    if (unknown.length) {
      p.clear.run();
      unknown.forEach((w, i) => p.ins.run(i + 1, w));
      for (const r of p.stems.all() as { term: string; doc: number }[]) this.stems.set(unknown[r.doc - 1], r.term);
      if (this.stems.size > 200_000) this.stems.clear();
    }
    const stemOf = new Map<string, string>(); // stem -> first word with it
    for (const w of words) {
      const s = this.stems.get(w);
      if (s && !stemOf.has(s)) stemOf.set(s, w);
    }
    const ranked = [...stemOf]
      .map(([stem, word]) => ({ word, df: this.docFreq(stem) }))
      .filter((x) => x.df > 0)
      .sort((a, b) => a.df - b.df || b.word.length - a.word.length)
      .slice(0, max)
      .map((x) => `"${x.word}"`);
    if (ranked.length <= 2) return ranked.join(' OR ');
    const pairs: string[] = [];
    for (let i = 0; i < ranked.length; i++) for (let j = i + 1; j < ranked.length; j++) pairs.push(`(${ranked[i]} AND ${ranked[j]})`);
    return pairs.join(' OR ');
  }

  /** Similar existing questions (FTS prefilter on rare words, then cosine over word/char features). */
  similar(type: QType, prompt: string, spec: any, opts: { excludeId?: number; limit?: number } = {}): SimilarHit[] {
    const text = `${prompt}\n${answerKey(type, spec)}`;
    const match = this.rareMatch(`${prompt} ${searchBody(type, spec)}`);
    if (!match) return [];
    const cands = this.db
      .prepare(
        `SELECT q.id, q.type, q.prompt, q.spec FROM questions_fts f JOIN questions q ON q.id = f.rowid
         WHERE questions_fts MATCH ? AND q.status != 'archived' ORDER BY bm25(questions_fts) LIMIT 25`,
      )
      .all(match) as { id: number; type: QType; prompt: string; spec: string }[];
    const v = textVector(text);
    return cands
      .filter((c) => c.id !== opts.excludeId)
      .map((c) => ({
        id: c.id,
        prompt: c.prompt.length > 160 ? c.prompt.slice(0, 157) + '...' : c.prompt,
        similarity: +cosine(v, textVector(`${c.prompt}\n${answerKey(c.type, JSON.parse(c.spec))}`)).toFixed(3),
      }))
      .filter((h) => h.similarity >= 0.5)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, opts.limit ?? 5);
  }

  private vecCache: Map<number, { v: Float32Array; type: QType; spec: any; prompt: string }> | null = null;

  private vectors() {
    if (!this.vecCache) {
      this.vecCache = new Map();
      const rows = this.db.prepare(`SELECT id, type, spec, prompt, embedding FROM questions WHERE embedding IS NOT NULL AND status != 'archived'`).all() as any[];
      for (const r of rows) this.vecCache.set(r.id, { v: fromBlob(r.embedding), type: r.type, spec: JSON.parse(r.spec), prompt: r.prompt });
    }
    return this.vecCache;
  }

  /** Questions that mean the same thing (embedding similarity + agreeing answers). */
  semanticSimilar(vec: Float32Array, type: QType, spec: any, opts: { excludeId?: number; limit?: number } = {}): SimilarHit[] {
    const hits: SimilarHit[] = [];
    for (const [id, c] of this.vectors()) {
      if (id === opts.excludeId) continue;
      const s = dot(vec, c.v);
      if (s < SEMANTIC_THRESHOLD) continue;
      if (s < SEMANTIC_ANY_ANSWER && !answersAgree(type, spec, c.type, c.spec)) continue;
      hits.push({ id, similarity: +s.toFixed(3), prompt: c.prompt.length > 160 ? c.prompt.slice(0, 157) + '...' : c.prompt, match: 'meaning' });
    }
    return hits.sort((a, b) => b.similarity - a.similarity).slice(0, opts.limit ?? 5);
  }

  /** Embed prompts, then add. Use this from async callers; falls back to wording-only checks offline. */
  async addAsync(items: unknown[], opts: Parameters<Questions['add']>[1] = {}) {
    const texts = items.map((it: any) => (typeof it?.prompt === 'string' ? embedText(it.prompt) : ''));
    const vecs = await embed(texts.map((t) => t || ' ')).catch(() => null);
    return this.add(items, { ...opts, vectors: vecs ?? undefined });
  }

  /** Fill in missing embeddings (after edits, or questions added while the model was unavailable). */
  async backfillEmbeddings(limit = 256): Promise<number> {
    const rows = this.db.prepare(`SELECT id, prompt FROM questions WHERE embedding IS NULL AND status != 'archived' LIMIT ?`).all(limit) as { id: number; prompt: string }[];
    if (!rows.length) return 0;
    const vecs = await embed(rows.map((r) => embedText(r.prompt)));
    if (!vecs) return 0;
    const st = this.db.prepare('UPDATE questions SET embedding = ? WHERE id = ?');
    rows.forEach((r, i) => st.run(toBlob(vecs[i]), r.id));
    this.vecCache = null;
    return rows.length;
  }

  /** Resolve tag paths strictly. Returns tag ids or the unresolved paths with suggestions. */
  resolveTags(paths: string[]) {
    const ids: number[] = [];
    const unresolved: { input: string; missing: string[]; suggestions: Suggestion[] }[] = [];
    for (const p of paths) {
      const r = this.tags.resolve(p);
      if (r.tag_id) ids.push(r.tag_id);
      else unresolved.push({ input: p, missing: r.missing, suggestions: r.suggestions });
    }
    return { ids: [...new Set(ids)], unresolved };
  }

  /**
   * Bulk add. Each item succeeds or fails on its own. Never creates tags.
   * Order of checks: schema -> client_ref (idempotency) -> tags -> exact hash -> similarity.
   */
  add(items: unknown[], opts: { actor?: string; dryRun?: boolean; status?: 'draft' | 'active'; vectors?: (Float32Array | null)[] } = {}): AddResult[] {
    if (items.length > MAX_BATCH) throw new Error(`At most ${MAX_BATCH} questions per call (got ${items.length}). Split the batch.`);
    const actor = opts.actor ?? 'user';
    const status = opts.status ?? (actor.startsWith('agent') && getSetting(this.db, 'agent_drafts', true) ? 'draft' : 'active');
    const batch: { type: QType; prompt: string; spec: any; hash: string; index: number; vec: Float32Array | null; tv: ReturnType<typeof textVector> }[] = [];
    const results: AddResult[] = [];

    const run = () => {
      items.forEach((item, index) => {
        const v = this.validate(item);
        if (!v.ok) return results.push({ index, status: 'invalid', errors: v.errors });
        const { q, spec } = v;

        if (q.client_ref) {
          const ex = this.db.prepare('SELECT id FROM questions WHERE client_ref = ?').get(q.client_ref) as { id: number } | undefined;
          if (ex) return results.push({ index, status: 'exists', id: ex.id, note: 'client_ref already used; returning the existing question' });
        }

        const { ids: tagIds, unresolved } = this.resolveTags(q.tags);
        if (unresolved.length)
          return results.push({
            index, status: 'unresolved_tags', tags: unresolved,
            note: 'Tags are never created implicitly. Use a suggested existing tag, or create it with create_tags, then retry this item.',
          });

        const hash = contentHash(q.type, q.prompt, answerKey(q.type, spec));
        const exact = this.db.prepare(`SELECT id, prompt FROM questions WHERE content_hash = ? AND status != 'archived'`).get(hash) as
          | { id: number; prompt: string }
          | undefined;
        if (exact)
          return results.push({ index, status: 'duplicate', duplicate_of: [{ id: exact.id, similarity: 1, prompt: exact.prompt }], note: 'Identical question already exists.' });

        const hits: SimilarHit[] = this.similar(q.type, q.prompt, spec).map((h) => ({ ...h, match: 'wording' }));
        const vec = opts.vectors?.[index] ?? null;
        // Also compare against earlier items of this batch.
        const v1 = textVector(`${q.prompt}\n${answerKey(q.type, spec)}`);
        for (const b of batch) {
          const ref = { id: -1 - b.index, prompt: `(item ${b.index} in this batch)` };
          if (b.hash === hash) { hits.unshift({ ...ref, similarity: 1, match: 'wording' }); continue; }
          const s = cosine(v1, b.tv);
          if (s >= NEAR_DUPLICATE_THRESHOLD) hits.push({ ...ref, similarity: +s.toFixed(3), match: 'wording' });
          else if (vec && b.vec) {
            const m = dot(vec, b.vec);
            if (m >= SEMANTIC_ANY_ANSWER || (m >= SEMANTIC_THRESHOLD && answersAgree(q.type, spec, b.type, b.spec)))
              hits.push({ ...ref, similarity: +m.toFixed(3), match: 'meaning' });
          }
        }
        if (vec)
          for (const h of this.semanticSimilar(vec, q.type, spec)) {
            // A meaning match outranks a weak (below-threshold) wording match on the same question.
            const k = hits.findIndex((x) => x.id === h.id);
            if (k < 0) hits.push(h);
            else if (hits[k].similarity < NEAR_DUPLICATE_THRESHOLD) hits[k] = h;
          }
        hits.sort((a, b) => b.similarity - a.similarity);
        // Only wording matches can reject; meaning matches are flagged for review.
        const dups = hits.filter((h) => h.match === 'wording' && h.similarity >= DUPLICATE_THRESHOLD);
        if (dups.length)
          return results.push({
            index, status: 'duplicate', duplicate_of: dups,
            note: `Too similar (>= ${DUPLICATE_THRESHOLD}). Edit the existing question with update_question, or make this one test something different.`,
          });
        const near = hits.filter((h) => h.match === 'meaning' || h.similarity >= NEAR_DUPLICATE_THRESHOLD);
        batch.push({ type: q.type, prompt: q.prompt, spec, hash, index, vec, tv: v1 });

        if (opts.dryRun) return results.push({ index, status: 'would_create', near_duplicates: near.length ? near : undefined, question_status: status });

        const t = now();
        const info = this.db
          .prepare(
            `INSERT INTO questions(type, prompt, spec, explanation, hints, difficulty, source, source_ref, group_id, status,
               near_duplicate_of, content_hash, client_ref, created_by, created_at, updated_at)
             VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            q.type, q.prompt, JSON.stringify(spec), q.explanation ?? null, JSON.stringify(q.hints ?? []), q.difficulty ?? 3,
            q.citation ?? null, q.source ? JSON.stringify(q.source) : null, q.group_id ?? null, status,
            near.filter((h) => h.id > 0).length ? JSON.stringify(near.filter((h) => h.id > 0).map((h) => h.id)) : null,
            hash, q.client_ref ?? null, actor, t, t,
          );
        const id = Number(info.lastInsertRowid);
        if (vec) {
          this.db.prepare('UPDATE questions SET embedding = ? WHERE id = ?').run(toBlob(vec), id);
          this.vectors().set(id, { v: vec, type: q.type, spec, prompt: q.prompt });
        }
        for (const tid of tagIds) this.db.prepare('INSERT INTO question_tags(question_id, tag_id) VALUES(?, ?)').run(id, tid);
        this.index(id, q.type, q.prompt, spec);
        this.snapshot(id, 'create', actor);
        results.push({ index, status: 'created', id, near_duplicates: near.length ? near : undefined, question_status: status });
      });
    };
    if (opts.dryRun) run();
    else tx(this.db, run);
    return results;
  }

  private index(id: number, type: QType, prompt: string, spec: any) {
    this.db.prepare('DELETE FROM questions_fts WHERE rowid = ?').run(id);
    this.db.prepare('INSERT INTO questions_fts(rowid, prompt, body) VALUES(?, ?, ?)').run(id, prompt, searchBody(type, spec));
  }

  private snapshot(id: number, kind: string, actor: string) {
    const q = this.get(id)!;
    const { tags, ...rest } = q;
    this.db
      .prepare('INSERT OR REPLACE INTO question_versions(question_id, version, snapshot, edit_kind, edited_by, edited_at) VALUES(?,?,?,?,?,?)')
      .run(id, q.version, JSON.stringify({ ...rest, tags: tags.map((t) => t.path) }), kind, actor, now());
  }

  versions(id: number) {
    return (this.db.prepare('SELECT version, edit_kind, edited_by, edited_at, snapshot FROM question_versions WHERE question_id = ? ORDER BY version').all(id) as any[]).map(
      (r) => ({ ...r, snapshot: JSON.parse(r.snapshot) }),
    );
  }

  /**
   * Edit a question. Fields not given are kept. A change to type or answer fields is a "major" edit:
   * it resets the review schedule and calibrated difficulty, since past attempts no longer apply.
   */
  update(id: number, patch: Record<string, unknown>, opts: { actor?: string; editKind?: 'minor' | 'major' } = {}) {
    return tx(this.db, () => {
      const cur = this.get(id);
      if (!cur) throw new Error(`Question ${id} not found.`);
      const merged: Record<string, unknown> = {
        type: cur.type, prompt: cur.prompt, tags: cur.tags.map((t) => t.path), difficulty: cur.difficulty,
        explanation: cur.explanation ?? undefined, hints: cur.hints, citation: cur.citation ?? undefined, source: cur.source ?? undefined,
        group_id: cur.group_id ?? undefined, ...(patch.type && patch.type !== cur.type ? {} : cur.spec),
      };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined && k !== 'id' && k !== 'client_ref') merged[k] = v === null ? undefined : v;
      const v = this.validate(merged);
      if (!v.ok) throw new Error(`Invalid edit: ${v.errors.join('; ')}`);
      const { q, spec } = v;
      const { ids: tagIds, unresolved } = this.resolveTags(q.tags);
      if (unresolved.length) {
        const e = new Error('Unresolved tags. Use existing tags or create them first with create_tags.');
        (e as any).details = unresolved;
        throw e;
      }
      const answerChanged = q.type !== cur.type || JSON.stringify(spec) !== JSON.stringify(cur.spec);
      const kind = opts.editKind ?? (answerChanged ? 'major' : 'minor');
      const hash = contentHash(q.type, q.prompt, answerKey(q.type, spec));
      const dup = this.db.prepare(`SELECT id FROM questions WHERE content_hash = ? AND id != ? AND status != 'archived'`).get(hash, id) as { id: number } | undefined;
      if (dup) throw new Error(`This edit would make the question identical to question ${dup.id}.`);
      this.db
        .prepare(
          `UPDATE questions SET type=?, prompt=?, spec=?, explanation=?, hints=?, difficulty=?, source=?, source_ref=?, group_id=?,
             content_hash=?, version=version+1, updated_at=?, irt_b = CASE WHEN ? THEN NULL ELSE irt_b END WHERE id=?`,
        )
        .run(
          q.type, q.prompt, JSON.stringify(spec), q.explanation ?? null, JSON.stringify(q.hints ?? []), q.difficulty ?? 3,
          q.citation ?? null, q.source ? JSON.stringify(q.source) : null, q.group_id ?? null, hash, now(), kind === 'major' ? 1 : 0, id,
        );
      if (patch.flagged_reason === null || kind === 'major') this.db.prepare('UPDATE questions SET flagged_reason = NULL WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM question_tags WHERE question_id = ?').run(id);
      for (const tid of tagIds) this.db.prepare('INSERT INTO question_tags(question_id, tag_id) VALUES(?, ?)').run(id, tid);
      if (kind === 'major') this.db.prepare('DELETE FROM srs_cards WHERE question_id = ?').run(id);
      if (q.prompt !== cur.prompt) this.db.prepare('UPDATE questions SET embedding = NULL WHERE id = ?').run(id); // re-embedded by backfill
      this.vecCache = null;
      this.index(id, q.type, q.prompt, spec);
      this.snapshot(id, kind, opts.actor ?? 'user');
      return { question: this.get(id)!, edit_kind: kind, previous_version: cur.version, schedule_reset: kind === 'major' };
    });
  }

  /** Restore an older version as a new version. */
  restore(id: number, version: number, actor = 'user') {
    const row = this.db.prepare('SELECT snapshot FROM question_versions WHERE question_id = ? AND version = ?').get(id, version) as { snapshot: string } | undefined;
    if (!row) throw new Error(`Version ${version} of question ${id} not found.`);
    const s = JSON.parse(row.snapshot);
    return this.update(id, { type: s.type, prompt: s.prompt, ...s.spec, explanation: s.explanation ?? null, hints: s.hints, difficulty: s.difficulty, tags: s.tags, citation: s.citation ?? null, source: s.source ?? null, group_id: s.group_id ?? null }, { actor });
  }

  setStatus(ids: number[], status: Question['status']) {
    return tx(this.db, () => {
      const stmt = this.db.prepare('UPDATE questions SET status = ?, updated_at = ? WHERE id = ?');
      let n = 0;
      for (const id of ids) n += Number(stmt.run(status, now(), id).changes);
      this.vecCache = null;
      return n;
    });
  }

  flag(id: number, reason: string | null) {
    this.db.prepare('UPDATE questions SET flagged_reason = ?, updated_at = ? WHERE id = ?').run(reason, now(), id);
  }

  search(f: {
    query?: string; tags?: string[]; type?: QType[]; status?: Question['status'][]; difficulty?: [number, number];
    flagged?: boolean; created_by?: string; limit?: number; offset?: number;
  }) {
    const where: string[] = [];
    const args: any[] = [];
    let from = 'questions q';
    let order = 'q.updated_at DESC';
    if (f.query?.trim()) {
      const terms = f.query.trim().split(/\s+/).map((w) => w.replace(/["*]/g, '')).filter(Boolean).map((w) => `"${w}"*`).join(' ');
      if (terms) {
        from = 'questions_fts f JOIN questions q ON q.id = f.rowid';
        where.push('questions_fts MATCH ?');
        args.push(terms);
        order = 'bm25(questions_fts)';
      }
    }
    if (f.tags?.length) {
      const ids: number[] = [];
      for (const p of f.tags) {
        const r = this.tags.resolve(p);
        if (r.tag_id) ids.push(...this.tags.descendantIds(r.tag_id));
      }
      if (!ids.length) return { total: 0, items: [] as Question[] };
      where.push(`q.id IN (SELECT question_id FROM question_tags WHERE tag_id IN (${ids.map(() => '?').join(',')}))`);
      args.push(...ids);
    }
    if (f.type?.length) { where.push(`q.type IN (${f.type.map(() => '?').join(',')})`); args.push(...f.type); }
    if (f.status?.length) { where.push(`q.status IN (${f.status.map(() => '?').join(',')})`); args.push(...f.status); }
    else where.push(`q.status != 'archived'`);
    if (f.difficulty) { where.push('q.difficulty BETWEEN ? AND ?'); args.push(f.difficulty[0], f.difficulty[1]); }
    if (f.flagged) where.push('q.flagged_reason IS NOT NULL');
    if (f.created_by) { where.push('q.created_by LIKE ?'); args.push(f.created_by + '%'); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) n FROM ${from} ${w}`).get(...args) as { n: number }).n;
    const ids = (this.db.prepare(`SELECT q.id FROM ${from} ${w} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, f.limit ?? 50, f.offset ?? 0) as { id: number }[]).map((r) => r.id);
    return { total, items: this.getMany(ids) };
  }
}
