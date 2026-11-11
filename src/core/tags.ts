import { type DB, tx, now } from './db.ts';
import { slugify, splitPath, displayName, jaroWinkler, trigramSim, tokenSetSim, isAcronymOf } from './text.ts';

export interface Tag {
  id: number;
  name: string;
  slug: string;
  parent_id: number | null;
  path: string;
  description: string | null;
  created_by: string;
}

export interface Suggestion {
  id: number;
  path: string;
  name: string;
  score: number;
  reason: string;
}

export interface Resolution {
  input: string;
  /** Tag id when the full path resolved to an existing tag. */
  tag_id: number | null;
  path: string | null;
  how: 'exact' | 'alias' | null;
  /** Segments that do not exist yet (display names), in order. */
  missing: string[];
  /** Existing tags that probably mean the same thing. Reuse one instead of creating. */
  suggestions: Suggestion[];
}

export class TagError extends Error {
  details?: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.details = details;
  }
}

const COLS = 'id, name, slug, parent_id, path, description, created_by';

function slugVariants(slug: string): string[] {
  const out = [slug + 's', slug + 'es'];
  if (slug.endsWith('s')) out.push(slug.slice(0, -1));
  if (slug.endsWith('es')) out.push(slug.slice(0, -2));
  return out.filter((v) => v.length > 2);
}

export class Tags {
  private db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  get(id: number): Tag | undefined {
    return this.db.prepare(`SELECT ${COLS} FROM tags WHERE id = ?`).get(id) as Tag | undefined;
  }

  /** Follow merges so callers always land on the live tag. */
  live(id: number): Tag | undefined {
    let row = this.db.prepare('SELECT id, merged_into_id FROM tags WHERE id = ?').get(id) as
      | { id: number; merged_into_id: number | null }
      | undefined;
    for (let i = 0; row?.merged_into_id && i < 20; i++)
      row = this.db.prepare('SELECT id, merged_into_id FROM tags WHERE id = ?').get(row.merged_into_id) as typeof row;
    return row ? this.get(row.id) : undefined;
  }

  byPath(path: string): Tag | undefined {
    return this.db.prepare(`SELECT ${COLS} FROM tags WHERE path = ? AND merged_into_id IS NULL`).get(path) as Tag | undefined;
  }

  all(): Tag[] {
    return this.db.prepare(`SELECT ${COLS} FROM tags WHERE merged_into_id IS NULL ORDER BY path`).all() as unknown as Tag[];
  }

  /** Ids of the tag and every descendant. */
  descendantIds(tagId: number): number[] {
    const t = this.get(tagId);
    if (!t) return [];
    return (
      this.db
        .prepare(`SELECT id FROM tags WHERE merged_into_id IS NULL AND (path = ? OR path LIKE ? || '/%')`)
        .all(t.path, t.path) as { id: number }[]
    ).map((r) => r.id);
  }

  /** Full tag pool, flat and sorted by path, with question counts and aliases. */
  tree(opts: { withStats?: boolean } = {}) {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.name, t.path, t.description, t.parent_id,
          (SELECT COUNT(*) FROM question_tags qt JOIN questions q ON q.id = qt.question_id
             WHERE qt.tag_id = t.id AND q.status IN ('active','draft')) AS questions,
          (SELECT group_concat(alias_slug, ', ') FROM tag_aliases a WHERE a.tag_id = t.id) AS aliases
         FROM tags t WHERE t.merged_into_id IS NULL ORDER BY t.path`,
      )
      .all() as {
      id: number; name: string; path: string; description: string | null; parent_id: number | null;
      questions: number; aliases: string | null;
    }[];
    let stats = new Map<number, { attempts: number; accuracy: number | null }>();
    if (opts.withStats) {
      const s = this.db
        .prepare(
          `SELECT qt.tag_id, COUNT(a.id) AS attempts, AVG(a.score) AS accuracy
           FROM question_tags qt JOIN attempts a ON a.question_id = qt.question_id
           WHERE a.score IS NOT NULL GROUP BY qt.tag_id`,
        )
        .all() as { tag_id: number; attempts: number; accuracy: number | null }[];
      stats = new Map(s.map((r) => [r.tag_id, { attempts: r.attempts, accuracy: r.accuracy }]));
    }
    // Roll question counts up to parents so the tree shows subtree totals.
    const byPath = new Map(rows.map((r) => [r.path, { ...r, total: r.questions }]));
    for (const r of rows) {
      const parts = r.path.split('/');
      for (let i = parts.length - 1; i > 0; i--) {
        const p = byPath.get(parts.slice(0, i).join('/'));
        if (p) p.total += r.questions;
      }
    }
    return [...byPath.values()].map((r) => ({
      id: r.id,
      path: r.path,
      name: r.name,
      description: r.description ?? undefined,
      questions: r.questions,
      subtree_questions: r.total,
      aliases: r.aliases ? r.aliases.split(', ') : undefined,
      ...(opts.withStats ? stats.get(r.id) ?? { attempts: 0, accuracy: null } : {}),
    }));
  }

  private child(parentId: number | null, slug: string): Tag | undefined {
    return this.db
      .prepare(`SELECT ${COLS} FROM tags WHERE merged_into_id IS NULL AND slug = ? AND parent_id IS ?`)
      .get(slug, parentId) as Tag | undefined;
  }

  private alias(parentPath: string, slug: string): Tag | undefined {
    const row = this.db
      .prepare('SELECT tag_id FROM tag_aliases WHERE parent_path = ? AND alias_slug = ?')
      .get(parentPath, slug) as { tag_id: number } | undefined;
    return row ? this.live(row.tag_id) : undefined;
  }

  /** Existing tags that look like `slug` (siblings first, then anywhere). */
  similar(slug: string, parentId: number | null, exclude = new Set<number>()): Suggestion[] {
    const out = new Map<number, Suggestion>();
    const consider = (t: Tag, sibling: boolean) => {
      if (exclude.has(t.id) || t.slug === slug && sibling) return;
      let score = 0, reason = '';
      const jw = jaroWinkler(slug, t.slug);
      const tri = trigramSim(slug, t.slug);
      const tok = tokenSetSim(slug, t.slug);
      if (t.slug === slug) { score = 0.99; reason = `same name exists at ${t.path}`; }
      else if (isAcronymOf(slug, t.slug) || isAcronymOf(t.slug, slug)) { score = 0.95; reason = 'acronym'; }
      else if (tok === 1) { score = 0.94; reason = 'same words, different order'; }
      else if (jw >= (sibling ? 0.92 : 0.95)) { score = jw; reason = 'very similar spelling'; }
      else if (tri >= (sibling ? 0.6 : 0.75) && Math.min(slug.length, t.slug.length) >= 4) { score = tri; reason = 'similar spelling'; }
      else if (sibling && tok >= 0.67 && slug.includes('-') && t.slug.includes('-')) { score = tok * 0.9; reason = 'mostly the same words'; }
      else if (sibling && (t.slug.startsWith(slug + '-') || slug.startsWith(t.slug + '-'))) { score = 0.8; reason = 'one name extends the other'; }
      if (score) {
        const prev = out.get(t.id);
        if (!prev || prev.score < score) out.set(t.id, { id: t.id, path: t.path, name: t.name, score: +score.toFixed(3), reason });
      }
    };
    for (const t of this.all()) consider(t, t.parent_id === parentId);
    // Aliases count as names too.
    const aliases = this.db.prepare('SELECT tag_id, alias_slug FROM tag_aliases').all() as { tag_id: number; alias_slug: string }[];
    for (const a of aliases) {
      const t = this.live(a.tag_id);
      if (!t || exclude.has(t.id)) continue;
      const jw = jaroWinkler(slug, a.alias_slug);
      if (a.alias_slug === slug || jw >= 0.94) {
        const score = a.alias_slug === slug ? 0.98 : jw;
        const prev = out.get(t.id);
        if (!prev || prev.score < score)
          out.set(t.id, { id: t.id, path: t.path, name: t.name, score: +score.toFixed(3), reason: `matches alias "${a.alias_slug}"` });
      }
    }
    return [...out.values()].sort((a, b) => b.score - a.score).slice(0, 5);
  }

  /** Resolve a human tag path ("Math > Calculus > Integrals") against the pool. Never creates. */
  resolve(input: string): Resolution {
    const segments = splitPath(input);
    const res: Resolution = { input, tag_id: null, path: null, how: null, missing: [], suggestions: [] };
    if (!segments.length) return res;
    let parent: Tag | null = null;
    let how: 'exact' | 'alias' = 'exact';
    for (let i = 0; i < segments.length; i++) {
      const slug = slugify(segments[i]);
      if (!slug) continue;
      const parentId: number | null = parent ? parent.id : null;
      let hit = this.child(parentId, slug);
      // Morphological variants of the last word ("kinematic" ~ "kinematics", "mechanic" ~ "mechanics").
      for (const v of slugVariants(slug)) {
        if (hit) break;
        hit = this.child(parentId, v);
      }
      if (!hit) {
        hit = this.alias(parent ? parent.path : '', slug);
        if (hit) how = 'alias';
      }
      if (!hit) {
        res.missing = segments.slice(i).map(displayName);
        res.suggestions = this.similar(slug, parentId);
        // A whole-path match elsewhere is a strong hint the agent put it under the wrong parent.
        if (i === 0 && segments.length > 1) {
          const leaf = slugify(segments[segments.length - 1]);
          for (const t of this.all())
            if (t.slug === leaf && !res.suggestions.some((s) => s.id === t.id))
              res.suggestions.push({ id: t.id, path: t.path, name: t.name, score: 0.9, reason: `leaf "${leaf}" exists at ${t.path}` });
        }
        res.path = parent?.path ?? null;
        return res;
      }
      parent = hit;
    }
    res.tag_id = parent!.id;
    res.path = parent!.path;
    res.how = how;
    return res;
  }

  /**
   * Create a tag path. Existing segments are reused. Each new segment is checked against
   * the pool; any near match blocks creation unless force is set with a justification.
   */
  create(
    input: string,
    opts: { description?: string; force?: boolean; justification?: string; actor?: string } = {},
  ): { tag: Tag; created: Tag[]; reused: boolean } {
    const r = this.resolve(input);
    if (r.tag_id) return { tag: this.get(r.tag_id)!, created: [], reused: true };
    if (r.suggestions.length && !opts.force)
      throw new TagError(
        `Not created: "${r.missing[0]}" looks like an existing tag. Reuse one of the suggestions, or retry with force=true and a justification if it is genuinely different.`,
        { suggestions: r.suggestions },
      );
    if (opts.force && r.suggestions.length && !opts.justification?.trim())
      throw new TagError('force=true requires a justification explaining why the suggested tags do not fit.');
    return tx(this.db, () => {
      let parent = r.path ? this.byPath(r.path)! : null;
      const created: Tag[] = [];
      for (let i = 0; i < r.missing.length; i++) {
        const name = r.missing[i];
        const slug = slugify(name);
        // Deeper new segments get the same fuzzy check against their (new, empty) siblings, which
        // can only match globally; only block on exact global name for those.
        const path = parent ? `${parent.path}/${slug}` : slug;
        const isLeaf = i === r.missing.length - 1;
        const info = this.db
          .prepare(
            `INSERT INTO tags(name, slug, parent_id, path, description, created_by, force_reason, created_at)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            name, slug, parent?.id ?? null, path,
            isLeaf ? opts.description ?? null : null,
            opts.actor ?? 'user',
            opts.force && r.suggestions.length ? opts.justification ?? null : null,
            now(),
          );
        parent = this.get(Number(info.lastInsertRowid))!;
        created.push(parent);
      }
      return { tag: parent!, created, reused: false };
    });
  }

  addAlias(tagId: number, alias: string) {
    const t = this.live(tagId);
    if (!t) throw new TagError(`Tag ${tagId} not found.`);
    const slug = slugify(alias);
    if (!slug || slug === t.slug) return t;
    const parentPath = t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/')) : '';
    const clash = this.child(t.parent_id, slug);
    if (clash) throw new TagError(`"${alias}" is already a separate tag (${clash.path}). Merge them instead.`, { id: clash.id });
    const existing = this.alias(parentPath, slug);
    if (existing && existing.id !== t.id) throw new TagError(`"${alias}" is already an alias of ${existing.path}.`);
    this.db.prepare('INSERT OR IGNORE INTO tag_aliases(tag_id, alias_slug, parent_path) VALUES(?, ?, ?)').run(t.id, slug, parentPath);
    return t;
  }

  private repath(tagId: number, newParentId: number | null, newSlug: string) {
    const t = this.get(tagId)!;
    const parent = newParentId ? this.get(newParentId)! : null;
    const newPath = parent ? `${parent.path}/${newSlug}` : newSlug;
    const oldPath = t.path;
    this.db.prepare('UPDATE tags SET parent_id = ?, slug = ?, path = ? WHERE id = ?').run(newParentId, newSlug, newPath, tagId);
    this.db
      .prepare(`UPDATE tags SET path = ? || substr(path, ?) WHERE merged_into_id IS NULL AND path LIKE ? || '/%'`)
      .run(newPath, oldPath.length + 1, oldPath);
    this.db
      .prepare(`UPDATE tag_aliases SET parent_path = ? || substr(parent_path, ?) WHERE parent_path = ? OR parent_path LIKE ? || '/%'`)
      .run(newPath, oldPath.length + 1, oldPath, oldPath);
  }

  /** Merge source into target: questions, children and aliases move; source name becomes an alias. */
  merge(sourceId: number, targetId: number): Tag {
    return tx(this.db, () => {
      const s = this.live(sourceId), t = this.live(targetId);
      if (!s || !t) throw new TagError('Tag not found.');
      if (s.id === t.id) return t;
      if (t.path.startsWith(s.path + '/')) throw new TagError('Cannot merge a tag into its own descendant.');
      this.db.prepare('INSERT OR IGNORE INTO question_tags(question_id, tag_id) SELECT question_id, ? FROM question_tags WHERE tag_id = ?').run(t.id, s.id);
      this.db.prepare('DELETE FROM question_tags WHERE tag_id = ?').run(s.id);
      for (const c of this.db.prepare(`SELECT ${COLS} FROM tags WHERE parent_id = ? AND merged_into_id IS NULL`).all(s.id) as unknown as Tag[]) {
        const clash = this.child(t.id, c.slug);
        if (clash) this.merge(c.id, clash.id);
        else this.repath(c.id, t.id, c.slug);
      }
      this.db.prepare('UPDATE tag_aliases SET tag_id = ? WHERE tag_id = ?').run(t.id, s.id);
      const sParent = s.path.includes('/') ? s.path.slice(0, s.path.lastIndexOf('/')) : '';
      this.db.prepare('INSERT OR IGNORE INTO tag_aliases(tag_id, alias_slug, parent_path) VALUES(?, ?, ?)').run(t.id, s.slug, sParent);
      this.db.prepare('UPDATE tags SET merged_into_id = ? WHERE id = ?').run(t.id, s.id);
      this.db.prepare('DELETE FROM ability WHERE tag_id = ?').run(s.id);
      return this.get(t.id)!;
    });
  }

  move(tagId: number, newParentPath: string | null): Tag {
    return tx(this.db, () => {
      const t = this.live(tagId);
      if (!t) throw new TagError(`Tag ${tagId} not found.`);
      let parentId: number | null = null;
      if (newParentPath) {
        const r = this.resolve(newParentPath);
        if (!r.tag_id) throw new TagError(`Parent "${newParentPath}" does not exist.`, r);
        if (r.path === t.path || r.path!.startsWith(t.path + '/')) throw new TagError('Cannot move a tag under itself.');
        parentId = r.tag_id;
      }
      const clash = this.child(parentId, t.slug);
      if (clash && clash.id !== t.id) throw new TagError(`A tag named "${t.slug}" already exists there (${clash.path}). Merge instead.`, { id: clash.id });
      this.repath(t.id, parentId, t.slug);
      return this.get(t.id)!;
    });
  }

  rename(tagId: number, name: string, description?: string): Tag {
    return tx(this.db, () => {
      const t = this.live(tagId);
      if (!t) throw new TagError(`Tag ${tagId} not found.`);
      const slug = slugify(name);
      if (!slug) throw new TagError('Empty name.');
      if (slug !== t.slug) {
        const clash = this.child(t.parent_id, slug);
        if (clash) throw new TagError(`"${name}" already exists (${clash.path}). Merge instead.`, { id: clash.id });
        const parentPath = t.path.includes('/') ? t.path.slice(0, t.path.lastIndexOf('/')) : '';
        this.repath(t.id, t.parent_id, slug);
        this.db.prepare('INSERT OR IGNORE INTO tag_aliases(tag_id, alias_slug, parent_path) VALUES(?, ?, ?)').run(t.id, t.slug, parentPath);
      }
      this.db.prepare('UPDATE tags SET name = ?, description = COALESCE(?, description) WHERE id = ?').run(displayName(name), description ?? null, t.id);
      return this.get(t.id)!;
    });
  }

  /** Delete an unused leaf tag (used to revert an agent's create). */
  deleteIfUnused(tagId: number): boolean {
    const used = this.db.prepare('SELECT 1 FROM question_tags WHERE tag_id = ? LIMIT 1').get(tagId);
    const kids = this.db.prepare('SELECT 1 FROM tags WHERE parent_id = ? LIMIT 1').get(tagId);
    if (used || kids) return false;
    this.db.prepare('DELETE FROM tag_aliases WHERE tag_id = ?').run(tagId);
    this.db.prepare('DELETE FROM ability WHERE tag_id = ?').run(tagId);
    this.db.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
    return true;
  }
}
