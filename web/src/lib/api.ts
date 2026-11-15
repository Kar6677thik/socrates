import { QueryClient, useQuery } from '@tanstack/react-query';

export const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: true, retry: 1 } },
});

export class ApiError extends Error {
  details: any;
  constructor(message: string, details?: any) {
    super(message);
    this.details = details;
  }
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch('/api' + url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  // Session expired (deployed instance): drop back to the sign-in screen.
  if (r.status === 401 && data.code === 'signin') qc.setQueryData<Session>(['/session'], { signedIn: false, loginRequired: true });
  if (!r.ok) throw new ApiError(data.error ?? r.statusText, data.details);
  return data as T;
}

export interface Session { signedIn: boolean; loginRequired: boolean }

export const api = {
  get: <T,>(url: string) => req<T>('GET', url),
  post: <T,>(url: string, body: unknown = {}) => req<T>('POST', url, body),
  patch: <T,>(url: string, body: unknown) => req<T>('PATCH', url, body),
  put: <T,>(url: string, body: unknown) => req<T>('PUT', url, body),
  del: <T,>(url: string) => req<T>('DELETE', url),
};

export const useApi = <T,>(url: string | null, opts: { refetchInterval?: number } = {}) =>
  useQuery<T>({ queryKey: [url], queryFn: () => api.get<T>(url!), enabled: !!url, ...opts });

export const invalidate = (...prefixes: string[]) =>
  qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && prefixes.some((p) => (q.queryKey[0] as string).startsWith(p)) });

// ---------- Shared types (mirrors the server) ----------

export type QType = 'mcq_single' | 'mcq_multi' | 'true_false' | 'fill_blank' | 'cloze' | 'numeric' | 'matching' | 'ordering' | 'short_answer' | 'code' | 'hotspot' | 'flashcard';

export const TYPE_LABELS: Record<QType, string> = {
  mcq_single: 'Multiple choice',
  mcq_multi: 'Multiple answer',
  true_false: 'True / false',
  fill_blank: 'Fill in the blank',
  numeric: 'Numeric',
  short_answer: 'Written answer',
  flashcard: 'Flashcard',
  matching: 'Matching',
  ordering: 'Ordering',
  cloze: 'Cloze',
  code: 'Code',
  hotspot: 'Image hotspot',
};
export const TYPES = Object.keys(TYPE_LABELS) as QType[];

export interface PublicQuestion {
  id: number;
  type: QType;
  prompt: string;
  spec: any;
  hints: number;
  difficulty: number;
  group_id: string | null;
  tags: string[];
  version: number;
}

export interface Question {
  id: number;
  type: QType;
  prompt: string;
  spec: any;
  explanation: string | null;
  hints: string[];
  difficulty: number;
  source: string | null;
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

export interface TagNode {
  id: number;
  path: string;
  name: string;
  description?: string;
  questions: number;
  subtree_questions: number;
  aliases?: string[];
  attempts?: number;
  accuracy?: number | null;
}

export interface Home {
  due: number;
  new_available: number;
  unseen: number;
  today: { answered: number; accuracy: number | null; time_ms: number };
  streak: { current: number; best: number };
  counts: { active: number; drafts: number; flagged: number; pending: number; tags: number };
  calendar: { day: string; n: number; acc: number | null }[];
  weak: { id: number; path: string; name: string; attempts: number; mastery: number; recent_accuracy: number | null; trend: number | null; confident_wrong: number }[];
  limits: { new_per_day: number; reviews_per_day: number; retention: number };
}

export interface SubmitResult {
  attempt_id: number;
  grade_status: 'auto' | 'self' | 'pending';
  score: number | null;
  correct: boolean | null;
  detail?: any;
  rating: number | null;
  next_due: number | null;
  answer: any;
  explanation: string | null;
  predicted?: number;
  leech?: boolean;
}

export interface Recommendation {
  kind: 'review' | 'weak' | 'overconfident' | 'fading' | 'new' | 'agent';
  title: string;
  reason: string;
  session?: Record<string, unknown>;
  agent_prompt?: string;
}

export type Mode = 'srs' | 'adaptive' | 'weak' | 'practice' | 'exam';
export const MODE_LABELS: Record<Mode, string> = { srs: 'Spaced review', adaptive: 'Adaptive', weak: 'Weak areas', practice: 'Practice', exam: 'Exam' };

/** Tag paths are stored as slugs; show them as readable breadcrumbs. */
export function tagLabel(path: string, names?: Map<string, string>) {
  const parts = path.split('/');
  return parts.map((_, i) => names?.get(parts.slice(0, i + 1).join('/')) ?? parts[i].replace(/-/g, ' ')).join(' › ');
}

export function useTagNames() {
  const { data } = useApi<TagNode[]>('/tags');
  return new Map((data ?? []).map((t) => [t.path, t.name]));
}

export const pct = (x: number | null | undefined) => (x == null ? '–' : `${Math.round(x * 100)}%`);
export const fmtMs = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};
export const fmtDue = (ts: number) => {
  const d = (ts - Date.now()) / 864e5;
  if (d < 1 / 24) return `${Math.max(1, Math.round(d * 1440))} min`;
  if (d < 1) return `${Math.round(d * 24)} h`;
  if (d < 45) return `${Math.round(d)} d`;
  if (d < 365) return `${Math.round(d / 30)} mo`;
  return `${(d / 365).toFixed(1)} y`;
};
export const ago = (ts: number) => {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};
