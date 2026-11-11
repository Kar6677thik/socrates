import { z } from 'zod';

/**
 * Question types. Each type defines:
 *  - spec: the type-specific fields (including the answer) an author supplies
 *  - publicSpec: what the UI may see before answering
 *  - answerKey: text used for duplicate detection
 *  - grade: auto grading (null = needs self or agent grading)
 */

const md = z.string().min(1);

export const SPECS = {
  mcq_single: z.object({
    options: z.array(md).min(2).max(10).describe('Answer options (markdown). Shuffled when shown.'),
    correct: z.number().int().min(0).describe('0-based index of the correct option'),
    shuffle: z.boolean().optional().describe('Default true. Set false for "all of the above" style options.'),
  }),
  mcq_multi: z.object({
    options: z.array(md).min(2).max(12),
    correct: z.array(z.number().int().min(0)).min(1).describe('0-based indices of all correct options'),
    shuffle: z.boolean().optional(),
  }),
  true_false: z.object({
    correct: z.boolean(),
  }),
  fill_blank: z.object({
    blanks: z
      .array(
        z.object({
          accept: z.array(z.string().min(1)).min(1).describe('Accepted answers for this blank'),
          case_sensitive: z.boolean().optional(),
          pattern: z.string().optional().describe('Optional regex (full match) accepted in addition to `accept`'),
        }),
      )
      .min(1)
      .describe('One entry per {{blank}} marker in the prompt, in order'),
  }),
  numeric: z.object({
    answer: z.number(),
    tolerance: z.number().min(0).optional().describe('Allowed error. Default: exact up to float noise'),
    relative: z.boolean().optional().describe('Treat tolerance as a fraction of the answer (0.01 = 1%)'),
    unit: z.string().optional().describe('Shown next to the input, e.g. "m/s"'),
  }),
  short_answer: z.object({
    model_answer: md.describe('Reference answer used for grading'),
    rubric: z
      .array(z.object({ criterion: z.string().min(1), points: z.number().positive() }))
      .optional()
      .describe('Grading criteria. Score = earned points / total points'),
    long: z.boolean().optional().describe('Essay-style: larger input box'),
  }),
  flashcard: z.object({
    back: md.describe('Answer side (markdown)'),
  }),
} as const;

export type QType = keyof typeof SPECS;
export const QTYPES = Object.keys(SPECS) as QType[];
export const AUTO_GRADED: QType[] = ['mcq_single', 'mcq_multi', 'true_false', 'fill_blank', 'numeric'];

export const TYPE_LABELS: Record<QType, string> = {
  mcq_single: 'Multiple choice',
  mcq_multi: 'Multiple answer',
  true_false: 'True / false',
  fill_blank: 'Fill in the blank',
  numeric: 'Numeric',
  short_answer: 'Short / long answer',
  flashcard: 'Flashcard',
};

export const BLANK_RE = /\{\{\s*blank\s*\}\}/g;

/** Cross-field checks zod alone can't express. Returns an error message or null. */
export function checkSpec(type: QType, prompt: string, spec: any): string | null {
  switch (type) {
    case 'mcq_single':
      if (spec.correct >= spec.options.length) return `correct=${spec.correct} is out of range for ${spec.options.length} options`;
      if (new Set(spec.options.map((o: string) => o.trim().toLowerCase())).size !== spec.options.length) return 'options contain duplicates';
      return null;
    case 'mcq_multi':
      if (spec.correct.some((i: number) => i >= spec.options.length)) return 'a correct index is out of range';
      if (new Set(spec.correct).size !== spec.correct.length) return 'correct contains duplicate indices';
      return null;
    case 'fill_blank': {
      const n = (prompt.match(BLANK_RE) ?? []).length;
      if (n === 0) return 'prompt must contain at least one {{blank}} marker';
      if (n !== spec.blanks.length) return `prompt has ${n} {{blank}} markers but ${spec.blanks.length} blanks were given`;
      for (const b of spec.blanks)
        if (b.pattern) try { new RegExp(b.pattern); } catch { return `invalid regex: ${b.pattern}`; }
      return null;
    }
    default:
      return null;
  }
}

/** Fields safe to show before answering. */
export function publicSpec(type: QType, spec: any) {
  switch (type) {
    case 'mcq_single':
    case 'mcq_multi':
      return { options: spec.options, shuffle: spec.shuffle !== false, ...(type === 'mcq_multi' ? { count: spec.correct.length } : {}) };
    case 'fill_blank':
      return { blanks: spec.blanks.length };
    case 'numeric':
      return { unit: spec.unit };
    case 'short_answer':
      return { long: !!spec.long, rubric: spec.rubric?.map((r: any) => ({ criterion: r.criterion, points: r.points })) };
    case 'flashcard':
      return { back: spec.back }; // self-rated: the back must be shown before rating
    default:
      return {};
  }
}

/** Text form of the answer, for duplicate detection. */
export function answerKey(type: QType, spec: any): string {
  switch (type) {
    case 'mcq_single': return [...spec.options].sort().join(' | ') + ' => ' + spec.options[spec.correct];
    case 'mcq_multi': return [...spec.options].sort().join(' | ') + ' => ' + spec.correct.map((i: number) => spec.options[i]).sort().join(',');
    case 'true_false': return String(spec.correct);
    case 'fill_blank': return spec.blanks.map((b: any) => b.accept[0]).join(' | ');
    case 'numeric': return `${spec.answer} ${spec.unit ?? ''}`;
    case 'short_answer': return spec.model_answer;
    case 'flashcard': return spec.back;
  }
}

/** Text indexed for search and similarity (prompt + options/answer). */
export function searchBody(type: QType, spec: any): string {
  switch (type) {
    case 'mcq_single':
    case 'mcq_multi': return spec.options.join(' ');
    case 'short_answer': return spec.model_answer;
    case 'flashcard': return spec.back;
    case 'fill_blank': return spec.blanks.map((b: any) => b.accept.join(' ')).join(' ');
    default: return '';
  }
}

export interface GradeResult {
  score: number;
  correct: boolean;
  /** Per-part detail for the UI (which options/blanks were right). */
  detail?: unknown;
}

const norm = (s: string, cs: boolean) => {
  const t = s.normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/[.。]$/, '');
  return cs ? t : t.toLowerCase();
};

function parseNumber(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/[\s,_]/g, '').replace(/[−–]/g, '-').replace(/×10\^/i, 'e').replace(/\*10\^/i, 'e');
  const frac = s.match(/^(-?\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  if (s.endsWith('%')) s = String(Number(s.slice(0, -1)) / 100);
  const n = Number(s);
  return s !== '' && Number.isFinite(n) ? n : null;
}

/** Auto-grade a response. Returns null for types that need self or agent grading. */
export function autoGrade(type: QType, spec: any, response: any): GradeResult | null {
  switch (type) {
    case 'mcq_single': {
      const ok = response?.choice === spec.correct;
      return { score: ok ? 1 : 0, correct: ok, detail: { correct: spec.correct } };
    }
    case 'mcq_multi': {
      const chosen = new Set<number>(Array.isArray(response?.choices) ? response.choices : []);
      const right = new Set<number>(spec.correct);
      let tp = 0, fp = 0;
      for (const c of chosen) right.has(c) ? tp++ : fp++;
      const score = Math.max(0, (tp - fp) / right.size);
      const ok = tp === right.size && fp === 0;
      return { score: +score.toFixed(3), correct: ok, detail: { correct: spec.correct } };
    }
    case 'true_false': {
      const ok = response?.value === spec.correct;
      return { score: ok ? 1 : 0, correct: ok, detail: { correct: spec.correct } };
    }
    case 'fill_blank': {
      const given: string[] = Array.isArray(response?.blanks) ? response.blanks : [];
      const results = spec.blanks.map((b: any, i: number) => {
        const g = String(given[i] ?? '');
        const cs = !!b.case_sensitive;
        if (b.accept.some((a: string) => norm(a, cs) === norm(g, cs))) return true;
        const n = parseNumber(g);
        if (n !== null && b.accept.some((a: string) => parseNumber(a) === n)) return true;
        if (b.pattern) try { return new RegExp(`^(?:${b.pattern})$`, cs ? '' : 'i').test(g.trim()); } catch { return false; }
        return false;
      });
      const score = results.filter(Boolean).length / results.length;
      return { score: +score.toFixed(3), correct: score === 1, detail: { blanks: results, accept: spec.blanks.map((b: any) => b.accept[0]) } };
    }
    case 'numeric': {
      const n = parseNumber(response?.value);
      if (n === null) return { score: 0, correct: false, detail: { answer: spec.answer, parsed: null } };
      const tol = spec.tolerance === undefined ? 1e-9 * Math.max(1, Math.abs(spec.answer)) : spec.relative ? spec.tolerance * Math.abs(spec.answer) : spec.tolerance;
      const ok = Math.abs(n - spec.answer) <= tol;
      return { score: ok ? 1 : 0, correct: ok, detail: { answer: spec.answer, parsed: n } };
    }
    default:
      return null;
  }
}

/** Response schema per type (validated on submit). */
export const RESPONSES: Record<QType, z.ZodType> = {
  mcq_single: z.object({ choice: z.number().int().nullable() }),
  mcq_multi: z.object({ choices: z.array(z.number().int()) }),
  true_false: z.object({ value: z.boolean().nullable() }),
  fill_blank: z.object({ blanks: z.array(z.string()) }),
  numeric: z.object({ value: z.string() }),
  short_answer: z.object({ text: z.string() }),
  flashcard: z.object({}).passthrough(),
};
