import { useEffect, useRef } from 'react';
import { useLocation, useSearch } from 'wouter';
import { startSession } from './Home';

const MODES = ['srs', 'adaptive', 'weak', 'practice', 'exam'];

/**
 * /study/start?mode=weak&tag=<id>&limit=15: the one-tap link study tasks carry (get_study_tasks, Hey Ann cards).
 * Starts the session straight away; on failure it falls back to the session builder.
 */
export default function StartSession() {
  const [, nav] = useLocation();
  const p = new URLSearchParams(useSearch());
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const mode = MODES.includes(p.get('mode') ?? '') ? p.get('mode')! : 'adaptive';
    const tagIds = p.getAll('tag').map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 20);
    const limit = Math.min(200, Math.max(1, Number(p.get('limit')) || 0)) || undefined;
    const config = { mode, ...(tagIds.length ? { tag_ids: tagIds } : {}), ...(limit && mode !== 'srs' ? { limit } : {}) };
    startSession((to) => nav(to, { replace: true }), config).then(() => {
      if (location.pathname === '/study/start') nav(`/study?mode=${mode}`, { replace: true });
    });
  }, []);
  return <div className="text-muted text-[13px] fade-in">Starting your session…</div>;
}
