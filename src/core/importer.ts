import { randomBytes } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { writeFileSync, rmSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type DB, now } from './db.ts';
import type { Tags, Suggestion } from './tags.ts';
import type { Questions } from './questions.ts';
import { QTYPES, CLOZE_RE } from './qtypes.ts';
import { saveImage, mediaDir } from './media.ts';
import { readZip } from './zip.ts';

/**
 * Import questions from Anki (.apkg/.colpkg), CSV/TSV, Markdown, or a Socrates JSON export.
 *
 * Two steps: `upload` keeps the file for 30 minutes and returns a token; `preview` parses it
 * with the chosen options and plans the tags (reuse, create, or map onto a similar existing tag);
 * `commit` creates the tags you approved and adds the questions through the normal pipeline,
 * so duplicates are caught exactly as for anything else.
 */

export type ImportFormat = 'apkg' | 'csv' | 'markdown' | 'socrates';
export const FORMATS: ImportFormat[] = ['apkg', 'csv', 'markdown', 'socrates'];
export const MAX_UPLOAD = 300 * 1024 * 1024;

export interface ImportOptions {
  /** Added to every question. */
  tags?: string[];
  /** Anki: use the deck name as a tag. Default true. */
  deck_tags?: boolean;
  /** Anki: keep the note's own tags. Default true. */
  note_tags?: boolean;
}

export interface Item {
  type: string;
  prompt: string;
  tags: string[];
  [k: string]: unknown;
}

interface Parsed {
  items: Item[];
  errors: { where: string; message: string }[];
  warnings: string[];
  /** Files referenced from items as `@media/<name>` (images only are kept on commit). */
  media: Map<string, () => Buffer>;
  /** Socrates exports carry tag descriptions and aliases. */
  tagMeta?: { path: string; description?: string | null; aliases?: string[] }[];
}

export interface TagPlan {
  path: string;
  status: 'exists' | 'new' | 'similar';
  /** Existing tag the path resolves to (exists), or the top suggestion (similar). */
  target: string | null;
  suggestions: Suggestion[];
  count: number;
}

const FALLBACK_TAG = 'Imported';
const PLACEHOLDER = /@media\/([^\s)"'\\]+)/g;

// ---------------------------------------------------------------- uploads

const uploads = new Map<string, { name: string; format: ImportFormat; buf: Buffer; at: number; parsed?: { key: string; p: Parsed } }>();

export function detectFormat(name: string): ImportFormat {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'apkg' || ext === 'colpkg') return 'apkg';
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'csv';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'json') return 'socrates';
  throw new Error('Unsupported file. Use .apkg, .csv, .tsv, .txt, .md or a Socrates .json export.');
}

export function upload(name: string, buf: Buffer, format?: ImportFormat) {
  if (!buf.length) throw new Error('The file is empty.');
  if (buf.length > MAX_UPLOAD) throw new Error('File too large (max 300 MB).');
  const t = now();
  for (const [k, u] of uploads) if (t - u.at > 30 * 60_000) uploads.delete(k);
  const token = randomBytes(12).toString('base64url');
  uploads.set(token, { name: name.slice(0, 200), format: format ?? detectFormat(name), buf, at: t });
  return { token, name, format: uploads.get(token)!.format, bytes: buf.length };
}

function getUpload(token: string) {
  const u = uploads.get(token);
  if (!u) throw new Error('Upload not found or expired. Choose the file again.');
  return u;
}

function parseUpload(token: string, opts: ImportOptions): Parsed {
  const u = getUpload(token);
  const key = JSON.stringify(opts);
  if (u.parsed?.key === key) return u.parsed.p;
  const p = parse(u.format, u.buf, u.name, opts);
  u.parsed = { key, p };
  return p;
}

export function parse(format: ImportFormat, buf: Buffer, name: string, opts: ImportOptions = {}): Parsed {
  const p: Parsed =
    format === 'apkg' ? parseApkg(buf, opts)
    : format === 'csv' ? parseCsv(buf.toString('utf8'), name)
    : format === 'markdown' ? parseMarkdown(buf.toString('utf8'), name)
    : parseSocrates(buf.toString('utf8'));
  const extra = (opts.tags ?? []).map((t) => t.trim()).filter(Boolean);
  for (const it of p.items) {
    it.tags = [...new Set([...it.tags.map(normTagPath).filter(Boolean), ...extra])];
    if (!it.tags.length) it.tags = [FALLBACK_TAG];
  }
  return p;
}

const normTagPath = (s: string) => s.split(/\s*(?:::|>|›)\s*/).map((x) => x.replace(/_/g, ' ').trim()).filter(Boolean).join(' > ');

// ---------------------------------------------------------------- preview & commit

export function preview(tags: Tags, token: string, opts: ImportOptions = {}) {
  const u = getUpload(token);
  const p = parseUpload(token, opts);
  const counts = new Map<string, number>();
  for (const it of p.items) for (const t of it.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const plan: TagPlan[] = [...counts].map(([path, count]) => {
    const r = tags.resolve(path);
    if (r.tag_id) return { path, status: 'exists', target: r.path, suggestions: [], count };
    if (r.suggestions.length) return { path, status: 'similar', target: r.suggestions[0].path, suggestions: r.suggestions.slice(0, 3), count };
    return { path, status: 'new', target: null, suggestions: [], count };
  });
  plan.sort((a, b) => ({ similar: 0, new: 1, exists: 2 })[a.status] - ({ similar: 0, new: 1, exists: 2 })[b.status] || b.count - a.count);
  const byType: Record<string, number> = {};
  for (const it of p.items) byType[it.type] = (byType[it.type] ?? 0) + 1;
  return {
    token, name: u.name, format: u.format,
    total: p.items.length,
    by_type: byType,
    sample: p.items.slice(0, 6).map((it) => ({ ...it, prompt: stripPlaceholders(it.prompt) })),
    tags: plan,
    images: [...p.media.keys()].filter((k) => /\.(png|jpe?g|gif|webp|avif)$/i.test(k)).length,
    errors: p.errors.slice(0, 50),
    error_count: p.errors.length,
    warnings: p.warnings,
  };
}

const stripPlaceholders = (s: string) => s.replace(/!\[[^\]]*\]\(@media\/[^)]*\)/g, '🖼').replace(PLACEHOLDER, '');

/**
 * `tag_map` maps each imported tag path to an existing tag path to use instead, or to
 * "create" (the default for new tags). Similar tags default to their top suggestion.
 */
export async function commit(app: { db: DB; tags: Tags; questions: Questions }, token: string, opts: ImportOptions = {}, tagMap: Record<string, string> = {}) {
  const u = getUpload(token);
  const p = parseUpload(token, opts);
  const resolved = new Map<string, string>();
  const created: string[] = [];
  const tagErrors: string[] = [];
  for (const it of p.items) for (const t of it.tags) {
    if (resolved.has(t)) continue;
    const choice = tagMap[t];
    const r = app.tags.resolve(t);
    try {
      if (choice && choice !== 'create') {
        const target = app.tags.resolve(choice);
        if (!target.tag_id) throw new Error(`"${choice}" is not an existing tag`);
        resolved.set(t, choice);
      } else if (r.tag_id) resolved.set(t, t);
      else if (r.suggestions.length && choice !== 'create') resolved.set(t, r.suggestions[0].path);
      else {
        const c = app.tags.create(t, { force: true, justification: `Created by import of ${u.name}` });
        created.push(...c.created.map((x) => x.path));
        resolved.set(t, t);
      }
    } catch (e: any) {
      tagErrors.push(`${t}: ${e.message}`);
    }
  }
  // Tag descriptions and aliases from a Socrates export.
  for (const m of p.tagMeta ?? []) {
    const r = app.tags.resolve(resolved.get(m.path) ?? m.path);
    if (!r.tag_id) continue;
    for (const a of m.aliases ?? []) try { app.tags.addAlias(r.tag_id, a); } catch { /* alias already taken */ }
    if (m.description) app.db.prepare('UPDATE tags SET description = COALESCE(description, ?) WHERE id = ?').run(m.description, r.tag_id);
  }

  // Images: store each referenced file once, then swap placeholders for its URL.
  const urls = new Map<string, string | null>();
  const imageUrl = (name: string) => {
    if (!urls.has(name)) {
      const get = p.media.get(name);
      let url: string | null = null;
      if (get) try { url = saveImage(get()).url; } catch { url = null; }
      urls.set(name, url);
    }
    return urls.get(name);
  };
  let missingImages = 0;
  const fill = (it: Item): Item => {
    const s = JSON.stringify(it).replace(/!\[([^\]]*)\]\(@media\/([^)]*)\)/g, (_m, alt, name) => {
      const url = imageUrl(decodeURIComponent(name));
      if (!url) { missingImages++; return ''; }
      return `![${alt}](${url})`;
    }).replace(PLACEHOLDER, (_m, name) => imageUrl(decodeURIComponent(name)) ?? '');
    return JSON.parse(s);
  };

  const tally = { created: 0, duplicate: 0, exists: 0, invalid: 0, skipped_tags: 0 };
  const problems: { index: number; status: string; message: string; prompt: string }[] = [];
  const items: Item[] = p.items.map((it) => ({ ...fill(it), tags: it.tags.map((t) => resolved.get(t)).filter((x): x is string => !!x) }));
  const groups = new Map<string, number[]>();
  items.forEach((it, i) => {
    const st = it.status === 'draft' ? 'draft' : 'active';
    groups.set(st, [...(groups.get(st) ?? []), i]);
  });
  for (const [status, idx] of groups) {
    for (let k = 0; k < idx.length; k += 100) {
      const chunk = idx.slice(k, k + 100);
      if (k) await new Promise((r) => setImmediate(r)); // let the server answer other requests between chunks
      const res = app.questions.add(chunk.map((i) => { const { status: _s, ...rest } = items[i]; return rest; }), { actor: 'user', status: status as 'active' | 'draft' });
      for (const r of res) {
        const i = chunk[r.index];
        if (r.status === 'created') tally.created++;
        else if (r.status === 'duplicate') tally.duplicate++;
        else if (r.status === 'exists') tally.exists++;
        else {
          if (r.status === 'unresolved_tags') tally.skipped_tags++; else tally.invalid++;
          if (problems.length < 50)
            problems.push({ index: i, status: r.status, message: r.status === 'invalid' ? (r as any).errors?.join('; ') : 'Tag not available', prompt: items[i].prompt.slice(0, 120) });
        }
      }
    }
  }
  uploads.delete(token);
  return { ...tally, tags_created: [...new Set(created)], tag_errors: tagErrors, parse_errors: p.errors.length, missing_images: missingImages, problems };
}

// ---------------------------------------------------------------- CSV / TSV

/** RFC 4180 CSV with the delimiter detected from the first line (tab, comma or semicolon). */
export function parseCsvRows(text: string): string[][] {
  text = text.replace(/^\uFEFF/, '');
  // Anki's text export starts with #separator:tab style headers
  const meta = new Map<string, string>();
  while (text.startsWith('#')) {
    const nl = text.indexOf('\n');
    const line = text.slice(1, nl < 0 ? undefined : nl).trim();
    const [k, v] = line.split(':');
    if (k && v) meta.set(k.toLowerCase(), v.trim().toLowerCase());
    text = nl < 0 ? '' : text.slice(nl + 1);
  }
  const named: Record<string, string> = { tab: '\t', comma: ',', semicolon: ';', pipe: '|', space: ' ' };
  const first = text.split('\n', 1)[0];
  const count = (ch: string) => first.split('"').filter((_, i) => i % 2 === 0).join('').split(ch).length - 1;
  const delim = named[meta.get('separator') ?? ''] ?? ['\t', ',', ';'].sort((a, b) => count(b) - count(a))[0];
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"' && cell === '') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const COLS: Record<string, string[]> = {
  prompt: ['front', 'question', 'prompt', 'term', 'q', 'text'],
  answer: ['back', 'answer', 'definition', 'a', 'model answer'],
  tags: ['tags', 'tag', 'topic', 'deck', 'category'],
  explanation: ['explanation', 'extra', 'notes', 'note', 'back extra'],
  type: ['type'],
  options: ['options', 'choices'],
  source: ['source'],
};

function parseCsv(text: string, name: string): Parsed {
  const rows = parseCsvRows(text);
  const errors: Parsed['errors'] = [];
  const items: Item[] = [];
  if (!rows.length) return { items, errors: [{ where: name, message: 'No rows found.' }], warnings: [], media: new Map() };
  const head = rows[0].map((c) => c.trim().toLowerCase());
  const col: Record<string, number> = {};
  for (const [k, names] of Object.entries(COLS)) {
    const i = head.findIndex((h) => names.includes(h));
    if (i >= 0) col[k] = i;
  }
  const hasHeader = col.prompt !== undefined;
  if (!hasHeader) Object.assign(col, { prompt: 0, answer: 1, tags: 2 });
  const body = hasHeader ? rows.slice(1) : rows;
  body.forEach((r, k) => {
    const line = k + (hasHeader ? 2 : 1);
    const get = (c: string) => (col[c] !== undefined ? (r[col[c]] ?? '').trim() : '');
    const prompt = get('prompt');
    if (!prompt) return errors.push({ where: `row ${line}`, message: 'No question text.' });
    const it = buildItem({
      prompt, answer: get('answer'), type: get('type').toLowerCase(), explanation: get('explanation'), options: get('options'), source: get('source') || name,
      tags: splitTags(get('tags')),
    });
    if ('error' in it) errors.push({ where: `row ${line}`, message: String(it.error) });
    else items.push(it);
  });
  return { items, errors, warnings: [], media: new Map() };
}

/** "a; b", "a | b", "a, b" split on the separator; Anki-style "a::b c::d" splits on spaces; anything else is one tag. */
const splitTags = (s: string) => (s ? (/[;|,]/.test(s) ? s.split(/[;|,]/) : s.includes('::') ? s.split(/\s+/) : [s]).map((x) => x.trim()).filter(Boolean) : []);

const TYPE_ALIASES: Record<string, string> = { mcq: 'mcq_single', multiple_choice: 'mcq_single', choice: 'mcq_single', multi: 'mcq_multi', tf: 'true_false', bool: 'true_false', number: 'numeric', written: 'short_answer', essay: 'short_answer', basic: 'flashcard', card: 'flashcard' };

/** Turn loose prompt/answer fields into a typed question. */
function buildItem(f: { prompt: string; answer: string; type?: string; explanation?: string; options?: string | string[]; correct?: number[]; source?: string; tags: string[] }): Item | { error: string } {
  let type = TYPE_ALIASES[f.type ?? ''] ?? f.type ?? '';
  const options = Array.isArray(f.options) ? f.options : f.options ? f.options.split('|').map((x) => x.trim()).filter(Boolean) : [];
  if (!type) type = new RegExp(CLOZE_RE.source).test(f.prompt) ? 'cloze' : options.length ? 'mcq_single' : 'flashcard';
  if (!(QTYPES as string[]).includes(type)) return { error: `Unknown type "${f.type}".` };
  const base: Item = { type, prompt: f.prompt, tags: f.tags };
  if (f.explanation) base.explanation = f.explanation;
  if (f.source) base.citation = f.source.slice(0, 200);
  const ans = f.answer.trim();
  switch (type) {
    case 'flashcard':
      if (!ans) return { error: 'No answer.' };
      return { ...base, back: ans };
    case 'short_answer':
      if (!ans) return { error: 'No answer.' };
      return { ...base, model_answer: ans };
    case 'true_false': {
      const v = ans.toLowerCase();
      if (!['true', 'false', 't', 'f', 'yes', 'no'].includes(v)) return { error: 'True/false answer must be true or false.' };
      return { ...base, correct: ['true', 't', 'yes'].includes(v) };
    }
    case 'numeric': {
      const n = Number(ans.replace(/,/g, ''));
      if (!ans || !Number.isFinite(n)) return { error: 'Numeric answer must be a number.' };
      return { ...base, answer: n };
    }
    case 'cloze':
      if (!new RegExp(CLOZE_RE.source).test(f.prompt)) return { error: 'Cloze text needs {{c1::...}} markers.' };
      return ans && !f.explanation ? { ...base, explanation: ans } : base;
    case 'mcq_single':
    case 'mcq_multi': {
      if (options.length < 2) return { error: 'Multiple choice needs at least two options (separate them with |).' };
      let correct = f.correct ?? [];
      if (!correct.length) {
        const keys = ans.split(/[|;]/).map((x) => x.trim()).filter(Boolean);
        correct = keys.map((k) => {
          const byText = options.findIndex((o) => o.toLowerCase() === k.toLowerCase());
          if (byText >= 0) return byText;
          if (/^[a-z]$/i.test(k)) return k.toLowerCase().charCodeAt(0) - 97;
          if (/^\d+$/.test(k)) return Number(k) - 1;
          return -1;
        });
      }
      if (!correct.length || correct.some((i) => i < 0 || i >= options.length)) return { error: 'Answer must name the correct option (its text, letter or number).' };
      if (correct.length > 1 || type === 'mcq_multi') return { ...base, type: 'mcq_multi', options, correct };
      return { ...base, options, correct: correct[0] };
    }
    default:
      return { error: `Type ${type} can't be imported from this format; use a Socrates export.` };
  }
}

// ---------------------------------------------------------------- Markdown

/**
 * Blocks separated by a line of `---`. In each block:
 *   Q: question (continues over following lines)    or  a `#`/`##` heading as the question
 *   A: answer                                        or  the text under the heading
 *   - [x] right option / - [ ] wrong option          multiple choice
 *   E: explanation      Tags: a > b; c      Type: numeric
 * A block with only `Tags:` sets the default tags for the blocks after it.
 * Text with {{c1::...}} and no answer becomes a cloze question.
 */
export function parseMarkdown(text: string, name: string): Parsed {
  const errors: Parsed['errors'] = [];
  const items: Item[] = [];
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: { start: number; lines: string[] }[] = [];
  let cur: string[] = [], start = 1, fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (!fence && /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { blocks.push({ start, lines: cur }); cur = []; start = i + 2; }
    else cur.push(l);
  });
  blocks.push({ start, lines: cur });
  let defaults: string[] = [];
  for (const b of blocks) {
    const f: Record<string, string[]> = { q: [], a: [], e: [], tags: [], type: [] };
    const opts: { text: string; ok: boolean }[] = [];
    let field = '', inFence = false;
    for (const l of b.lines) {
      if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
      const m = !inFence && l.match(/^\s*(Q|A|E|Explanation|Tags?|Type)\s*:\s?(.*)$/i);
      const heading = !inFence && !field && l.match(/^\s*#{1,6}\s+(.*)$/);
      const opt = !inFence && (field === 'q' || field === 'h' || field === 'opt') && l.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
      if (m) {
        const k = m[1].toLowerCase();
        field = k === 'explanation' ? 'e' : k === 'tag' ? 'tags' : k;
        f[field].push(m[2]);
      } else if (heading) { field = 'h'; f.q.push(heading[1]); }
      else if (opt) { field = 'opt'; opts.push({ text: opt[2].trim(), ok: opt[1] !== ' ' }); }
      else if (field === 'h') { field = 'a'; f.a.push(l); }
      else if (field && field !== 'opt') f[field].push(l);
      else if (!field && l.trim()) { field = 'q'; f.q.push(l); }
    }
    const val = (k: string) => f[k].join('\n').trim();
    const tags = splitTags(val('tags').replace(/\n/g, ';'));
    if (!val('q')) {
      if (tags.length) defaults = tags;
      else if (b.lines.some((l) => l.trim())) errors.push({ where: `line ${b.start}`, message: 'No question found (start it with "Q:" or a heading).' });
      continue;
    }
    const it = buildItem({
      prompt: val('q'), answer: val('a'), type: val('type').toLowerCase(), explanation: val('e'),
      options: opts.map((o) => o.text), correct: opts.length ? opts.flatMap((o, i) => (o.ok ? [i] : [])) : undefined,
      source: name, tags: tags.length ? tags : defaults,
    });
    if ('error' in it) errors.push({ where: `line ${b.start}`, message: String(it.error) });
    else items.push(it);
  }
  return { items, errors, warnings: [], media: new Map() };
}

// ---------------------------------------------------------------- Socrates JSON

function parseSocrates(text: string): Parsed {
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error('Not valid JSON.'); }
  if (data?.format !== 'socrates' || !Array.isArray(data.questions)) throw new Error('Not a Socrates export (expected "format": "socrates").');
  const media = new Map<string, () => Buffer>();
  for (const [name, b64] of Object.entries<string>(data.media ?? {})) media.set(name, () => Buffer.from(b64, 'base64'));
  const items: Item[] = data.questions.map((q: any) => {
    const { id: _id, created_at: _c, updated_at: _u, ...rest } = q;
    // /media/<file> URLs become placeholders so the files are stored again on this machine
    return JSON.parse(JSON.stringify({ ...rest, tags: Array.isArray(q.tags) ? q.tags : [] }).replace(/\/media\/([a-f0-9]{16,64}\.[a-z0-9]+)/g, '@media/$1'));
  });
  return { items, errors: [], warnings: [], media, tagMeta: Array.isArray(data.tags) ? data.tags : [] };
}

/** Everything needed to rebuild the question bank elsewhere: tags, questions and their images. */
export function exportJson(db: DB) {
  const tagRows = db.prepare('SELECT id, name, parent_id, description FROM tags WHERE merged_into_id IS NULL').all() as { id: number; name: string; parent_id: number | null; description: string | null }[];
  const byId = new Map(tagRows.map((t) => [t.id, t]));
  const pathOf = (id: number): string => {
    const t = byId.get(id)!;
    return t.parent_id && byId.has(t.parent_id) ? `${pathOf(t.parent_id)} > ${t.name}` : t.name;
  };
  const aliases = new Map<number, string[]>();
  for (const a of db.prepare('SELECT tag_id, alias_slug FROM tag_aliases').all() as { tag_id: number; alias_slug: string }[])
    aliases.set(a.tag_id, [...(aliases.get(a.tag_id) ?? []), a.alias_slug.replace(/-/g, ' ')]);
  const qt = new Map<number, string[]>();
  for (const r of db.prepare('SELECT question_id, tag_id FROM question_tags').all() as { question_id: number; tag_id: number }[])
    if (byId.has(r.tag_id)) qt.set(r.question_id, [...(qt.get(r.question_id) ?? []), pathOf(r.tag_id)]);
  const qs = db.prepare(`SELECT id, type, prompt, spec, explanation, hints, difficulty, source, source_ref, group_id, status, client_ref, created_at FROM questions WHERE status != 'archived' ORDER BY id`).all() as any[];
  const questions = qs.map((q) => ({
    id: q.id, type: q.type, prompt: q.prompt, ...JSON.parse(q.spec),
    ...(q.explanation ? { explanation: q.explanation } : {}),
    ...(JSON.parse(q.hints ?? '[]').length ? { hints: JSON.parse(q.hints) } : {}),
    difficulty: q.difficulty, ...(q.source ? { citation: q.source } : {}), ...(q.source_ref ? { source: JSON.parse(q.source_ref) } : {}), ...(q.group_id ? { group_id: q.group_id } : {}),
    ...(q.client_ref ? { client_ref: q.client_ref } : {}),
    status: q.status === 'draft' ? 'draft' : 'active',
    tags: qt.get(q.id) ?? [],
    created_at: q.created_at,
  }));
  const media: Record<string, string> = {};
  const names = new Set<string>();
  for (const m of JSON.stringify(questions).matchAll(/\/media\/([a-f0-9]{16,64}\.[a-z0-9]+)/g)) names.add(m[1]);
  for (const n of names) {
    const f = join(mediaDir(), n);
    if (existsSync(f)) media[n] = readFileSync(f).toString('base64');
  }
  return {
    format: 'socrates', version: 1, exported_at: new Date(now()).toISOString(),
    tags: tagRows.map((t) => ({ path: pathOf(t.id), ...(t.description ? { description: t.description } : {}), ...(aliases.get(t.id) ? { aliases: aliases.get(t.id) } : {}) })),
    questions, media,
  };
}

// ---------------------------------------------------------------- Anki

/** Anki has no `|` alternatives in cloze answers, so bare pipes (outside math) become literal `\|`. */
function escapeClozePipes(text: string): string {
  return text.replace(new RegExp(CLOZE_RE.source, 'g'), (_m, n, ans: string, hint?: string) => {
    let out = '', math = false;
    for (const ch of ans) {
      if (ch === '$') math = !math;
      out += ch === '|' && !math ? '\\|' : ch;
    }
    return `{{c${n}::${out}${hint !== undefined ? `::${hint}` : ''}}}`;
  });
}

const isZstd =(b: Buffer) => b.length > 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;
const unz = (b: Buffer) => (isZstd(b) ? zstdDecompressSync(b) : b);

/** Read the repeated `MediaEntry { string name = 1; ... legacy_zip_filename = 255 }` list (anki21b exports). */
function protoMediaNames(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  const varint = (b: Buffer, p: { i: number }) => {
    let x = 0, s = 0;
    for (;;) { const c = b[p.i++]; x += (c & 0x7f) * 2 ** s; s += 7; if (c < 0x80) return x; }
  };
  const p = { i: 0 };
  let idx = 0;
  while (p.i < buf.length) {
    const key = varint(buf, p);
    const wt = key & 7;
    if (wt !== 2) throw new Error('Unexpected media index format.');
    const len = varint(buf, p);
    const msg = buf.subarray(p.i, p.i + len);
    p.i += len;
    if (key >> 3 !== 1) continue;
    const q = { i: 0 };
    let name = '', legacy: number | null = null;
    while (q.i < msg.length) {
      const k = varint(msg, q), f = k / 8 | 0, w = k & 7;
      if (w === 0) { const v = varint(msg, q); if (f === 255) legacy = v; }
      else if (w === 2) { const l = varint(msg, q); if (f === 1) name = msg.toString('utf8', q.i, q.i + l); q.i += l; }
      else if (w === 5) q.i += 4;
      else if (w === 1) q.i += 8;
    }
    out.set(String(legacy ?? idx), name);
    idx++;
  }
  return out;
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

/** Anki field HTML to markdown: line breaks, emphasis, lists, code, images and MathJax. */
export function htmlToMd(html: string, image: (src: string) => string | null): string {
  let s = html
    .replace(/\[sound:[^\]]*\]/g, '')
    .replace(/<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)["']?[^>]*>/gi, (_m, src) => {
      const r = image(decodeEntities(src));
      return r ? `![](${r})` : '';
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, x) => (x.trim() ? `**${x.trim()}**` : x))
    .replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, x) => (x.trim() ? `*${x.trim()}*` : x))
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, x) => '\n```\n' + x.replace(/<[^>]+>/g, '') + '\n```\n')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, x) => '`' + x + '`')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_m, x) => `$${x.trim()}$`)
    .replace(/\\\[([\s\S]*?)\\\]/g, (_m, x) => `$$${x.trim()}$$`)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

function parseApkg(buf: Buffer, opts: ImportOptions): Parsed {
  const zip = readZip(buf);
  const entry = zip.get('collection.anki21b') ?? zip.get('collection.anki21') ?? zip.get('collection.anki2');
  if (!entry) throw new Error('No Anki collection inside this file.');
  const dir = mkdtempSync(join(tmpdir(), 'socrates-anki-'));
  const errors: Parsed['errors'] = [];
  const warnings: string[] = [];
  const items: Item[] = [];
  const media = new Map<string, () => Buffer>();
  try {
    const dbPath = join(dir, 'collection.db');
    writeFileSync(dbPath, unz(entry.read()));
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // Media index: JSON {"0": "name.jpg"} in old exports, zstd protobuf in new ones.
      const m = zip.get('media');
      let names = new Map<string, string>();
      if (m) {
        const raw = unz(m.read());
        try { names = new Map(Object.entries(JSON.parse(raw.toString('utf8')))); }
        catch { names = protoMediaNames(raw); }
      }
      for (const [zipName, name] of names) {
        const e = zip.get(zipName);
        if (e) media.set(name, () => unz(e.read()));
      }

      const has = (t: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
      const col = db.prepare('SELECT * FROM col').get() as any;
      const deckNames = new Map<number, string>();
      const modelKind = new Map<number, { name: string; cloze: boolean; fields: string[] }>();
      if (has('decks') && has('notetypes')) {
        for (const d of db.prepare('SELECT id, name FROM decks').all() as any[]) deckNames.set(Number(d.id), String(d.name).replace(/\x1f/g, '::'));
        const fields = new Map<number, string[]>();
        for (const f of db.prepare('SELECT ntid, ord, name FROM fields ORDER BY ntid, ord').all() as any[]) fields.set(Number(f.ntid), [...(fields.get(Number(f.ntid)) ?? []), f.name]);
        for (const n of db.prepare('SELECT id, name FROM notetypes').all() as any[])
          modelKind.set(Number(n.id), { name: n.name, cloze: /cloze/i.test(n.name), fields: fields.get(Number(n.id)) ?? [] });
      } else {
        for (const d of Object.values<any>(JSON.parse(col.decks || '{}'))) deckNames.set(Number(d.id), d.name);
        for (const mm of Object.values<any>(JSON.parse(col.models || '{}')))
          modelKind.set(Number(mm.id), { name: mm.name, cloze: mm.type === 1, fields: (mm.flds ?? []).map((f: any) => f.name) });
      }
      const deckOf = new Map<number, number>();
      for (const c of db.prepare('SELECT nid, did FROM cards ORDER BY ord').all() as any[]) if (!deckOf.has(Number(c.nid))) deckOf.set(Number(c.nid), Number(c.did));

      const missing = new Set<string>();
      const image = (src: string) => {
        if (/^https?:/i.test(src)) return null;
        if (!media.has(src)) { missing.add(src); return null; }
        return `@media/${encodeURIComponent(src)}`;
      };
      const notes = db.prepare('SELECT id, guid, mid, tags, flds FROM notes ORDER BY id').all() as any[];
      for (const n of notes) {
        const model = modelKind.get(Number(n.mid));
        const raw = String(n.flds).split('\x1f');
        const fields = raw.map((f) => htmlToMd(f, image));
        const deck = deckNames.get(deckOf.get(Number(n.id)) ?? -1) ?? '';
        const tags = [
          ...(opts.note_tags !== false ? String(n.tags).trim().split(/\s+/).filter((t) => t && !/^(leech|marked)$/i.test(t)) : []),
          ...(opts.deck_tags !== false && deck && !/^default$/i.test(deck) ? [deck] : []),
        ];
        const where = `note ${n.id}`;
        if (raw.some((f) => /image-occlusion:/i.test(f))) { errors.push({ where, message: 'Image occlusion notes are not supported.' }); continue; }
        const isCloze = model?.cloze || new RegExp(CLOZE_RE.source).test(fields[0] ?? '');
        const source = `Anki${deck ? `: ${deck.replace(/::/g, ' > ')}` : ''}`;
        const it = isCloze
          ? buildItem({ prompt: escapeClozePipes(fields[0]), answer: '', type: 'cloze', explanation: fields.slice(1).filter(Boolean).join('\n\n'), source, tags })
          : buildItem({ prompt: fields[0], answer: fields.slice(1).filter(Boolean).join('\n\n'), type: 'flashcard', source, tags });
        if ('error' in it) { errors.push({ where, message: String(it.error) + (fields[0] ? ` (${fields[0].slice(0, 60)})` : '') }); continue; }
        it.client_ref = `anki-${n.guid}`;
        items.push(it);
      }
      if (missing.size) warnings.push(`${missing.size} image${missing.size > 1 ? 's' : ''} referenced by notes are missing from the file and will be left out.`);
      const audio = [...names.values()].filter((x) => /\.(mp3|ogg|wav|m4a|opus|webm|mp4)$/i.test(x)).length;
      if (audio) warnings.push(`${audio} audio or video file${audio > 1 ? 's are' : ' is'} not imported.`);
      if (!notes.length) errors.push({ where: 'collection', message: 'The collection has no notes.' });
      if (notes.length === 1 && /update to the latest anki/i.test(String(notes[0].flds))) throw new Error('This file only contains Anki\'s "please update" note. Export again with "Support older Anki versions" ticked, or use a newer export.');
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { items, errors, warnings, media };
}
