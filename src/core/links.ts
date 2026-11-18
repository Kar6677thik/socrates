// Addresses a person can open in the Socrates web app, built on the server so agents copy them rather than build
// them (the same rule as Sprawl's WebLinks and Slate's note URLs). Field naming across the apps:
//   url           on an object that IS a question, session or tag: "open this item in Socrates"
//   question_url  on an object that only refers to a question (an attempt, a mistake, a pending grade)
// The origin is SOCRATES_URL, else SOCRATES_PUBLIC_ORIGIN, else the local server.
import type { Mode } from './study.ts';

export function webOrigin(): string {
  const o = process.env.SOCRATES_URL || process.env.SOCRATES_PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 4321}`;
  return o.replace(/\/+$/, '');
}

const id = (n: unknown) => (Number.isInteger(n) && (n as number) > 0 ? (n as number) : null);

export const links = {
  question: (qid: unknown) => (id(qid) ? `${webOrigin()}/library/${qid}` : undefined),
  session: (sid: unknown) => (id(sid) ? `${webOrigin()}/study/${sid}` : undefined),
  tag: (tid: unknown) => (id(tid) ? `${webOrigin()}/library?tag=${tid}` : undefined),
  /** One tap starts this session; the page reads the parameters and starts it. Tags are ids, not paths. */
  start(cfg: { mode?: Mode; tagIds?: number[]; limit?: number }): string {
    const p = new URLSearchParams({ mode: cfg.mode ?? 'adaptive' });
    for (const t of cfg.tagIds ?? []) if (id(t)) p.append('tag', String(t));
    if (cfg.limit) p.set('limit', String(cfg.limit));
    return `${webOrigin()}/study/start?${p}`;
  },
};
