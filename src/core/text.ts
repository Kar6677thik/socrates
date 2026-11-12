import { createHash } from 'node:crypto';

// ---------- Tag normalization ----------

const IRREGULAR: Record<string, string> = {
  indices: 'index', matrices: 'matrix', vertices: 'vertex', analyses: 'analysis', theses: 'thesis',
  hypotheses: 'hypothesis', criteria: 'criterion', phenomena: 'phenomenon', data: 'data', media: 'media',
  children: 'child', people: 'person', mice: 'mouse', geese: 'goose', feet: 'foot', teeth: 'tooth',
};
// Words ending in "s" that are not plurals (or are mass nouns) in common study topics.
const KEEP_S = new Set([
  'physics', 'mathematics', 'math', 'economics', 'statistics', 'genetics', 'mechanics', 'dynamics',
  'thermodynamics', 'electronics', 'linguistics', 'ethics', 'politics', 'logistics', 'optics',
  'kinematics', 'calculus', 'analysis', 'basis', 'thesis', 'axis', 'status', 'news', 'series', 'species',
  'bias', 'gas', 'class', 'process', 'access', 'address', 'loss', 'less', 'chess', 'success', 'stress',
  'virus', 'bus', 'corpus', 'radius', 'nucleus', 'focus', 'consensus', 'campus', 'census', 'canvas',
  'aws', 'dns', 'os', 'ios', 'macos', 'css', 'sass', 'js', 'nodejs', 'kubernetes', 'redis', 'postgres',
  'graphics', 'semantics', 'pragmatics', 'phonetics', 'acoustics', 'robotics', 'diagnosis', 'synthesis',
  'osmosis', 'mitosis', 'meiosis', 'emphasis', 'crisis', 'genesis', 'paralysis', 'prognosis', 'atlas',
]);

export function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (IRREGULAR[word]) return IRREGULAR[word];
  if (KEEP_S.has(word) || word.endsWith('ss') || word.endsWith('us') || word.endsWith('is')) return word;
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (/(ches|shes|xes|zes|sses)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('oes')) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** "Integrals " / "INTEGRAL" / "integrals" -> "integral"; "Data & Algorithms" -> "data-and-algorithm". */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\+\+/g, 'pp')
    .replace(/#/g, 'sharp')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\.(?![0-9])/g, ' ')
    .trim();
  if (!base) return '';
  const words = base.split(/\s+/);
  words[words.length - 1] = singularize(words[words.length - 1]);
  return words.join('-');
}

/** Split "math > calculus > integrals" (also "/" or "::") into segments. */
export function splitPath(path: string): string[] {
  return path
    .split(/\s*(?:>|\/|::|›)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function displayName(raw: string): string {
  const t = raw.trim().replace(/\s+/g, ' ');
  return t;
}

// ---------- Fuzzy string similarity ----------

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const range = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const ma = new Array<boolean>(la).fill(false);
  const mb = new Array<boolean>(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - range), hi = Math.min(i + range + 1, lb);
    for (let j = lo; j < hi; j++) {
      if (mb[j] || a[i] !== b[j]) continue;
      ma[i] = mb[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < la; i++) {
    if (!ma[i]) continue;
    while (!mb[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / la + matches / lb + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, la, lb) && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function grams(s: string, n = 3): Map<string, number> {
  const padded = `  ${s} `;
  const m = new Map<string, number>();
  for (let i = 0; i + n <= padded.length; i++) {
    const g = padded.slice(i, i + n);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice coefficient over character trigrams. */
export function trigramSim(a: string, b: string): number {
  if (a === b) return 1;
  const ga = grams(a), gb = grams(b);
  let inter = 0, total = 0;
  for (const [g, c] of ga) { total += c; inter += Math.min(c, gb.get(g) ?? 0); }
  for (const c of gb.values()) total += c;
  return total ? (2 * inter) / total : 0;
}

/** Word-set similarity, catches reordered names ("linear algebra" vs "algebra linear"). */
export function tokenSetSim(a: string, b: string): number {
  const sa = new Set(a.split('-')), sb = new Set(b.split('-'));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / Math.max(sa.size, sb.size);
}

/** Acronym check: "ml" vs "machine-learning". */
export function isAcronymOf(short: string, long: string): boolean {
  const words = long.split('-').filter((w) => !['and', 'of', 'the', 'for', 'in'].includes(w));
  return words.length > 1 && short.replace(/-/g, '') === words.map((w) => w[0]).join('');
}

// ---------- Question similarity ----------

const STOP = new Set(
  'a an the of to in on for and or is are was were be been what which who whom whose why how when where does do did this that these those it its with as by at from into than then so such can could would should will shall may might must there their they them your you i we our'.split(
    ' ',
  ),
);

export function normalizeText(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/\s+/g, ' '))
    .replace(/[^a-z0-9$\\^_{}()+\-*/=<>.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function contentHash(type: string, prompt: string, answerKey: string): string {
  return createHash('sha256').update(`${type}\n${normalizeText(prompt)}\n${normalizeText(answerKey)}`).digest('hex').slice(0, 32);
}

function lightStem(w: string) {
  return w.length > 4 ? w.replace(/(ing|ed|es|s)$/, '') : w;
}

/** Sparse vector of word unigrams + bigrams + char trigrams for cosine similarity. */
export function textVector(s: string): Map<string, number> {
  const norm = normalizeText(s);
  const words = norm.split(' ').filter((w) => w && !STOP.has(w)).map(lightStem);
  const v = new Map<string, number>();
  const add = (k: string, w: number) => v.set(k, (v.get(k) ?? 0) + w);
  for (const w of words) add('w:' + w, 1);
  for (let i = 0; i + 1 < words.length; i++) add('b:' + words[i] + '_' + words[i + 1], 1.5);
  const compact = words.join(' ');
  for (let i = 0; i + 3 <= compact.length; i++) add('c:' + compact.slice(i, i + 3), 0.15);
  return v;
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  for (const [k, x] of a) { na += x * x; const y = b.get(k); if (y) dot += x * y; }
  for (const y of b.values()) nb += y * y;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Build an FTS5 OR query from the most informative words of a text. */
/** Distinct content words worth searching for (no stop words, no short tokens). */
export function searchWords(s: string): string[] {
  return [...new Set(normalizeText(s).split(' '))].filter((w) => w.length > 2 && !STOP.has(w) && /^[a-z0-9]+$/.test(w));
}

export function ftsQuery(s: string, max = 12): string {
  const words = searchWords(s)
    .sort((a, b) => b.length - a.length)
    .slice(0, max);
  return words.map((w) => `"${w}"`).join(' OR ');
}
