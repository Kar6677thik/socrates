import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { api, useApi, tagLabel, type TagNode, type Recommendation, type Question, MODE_LABELS, type Mode } from '../lib/api';
import { plain } from '../lib/md';
import { startSession } from '../pages/Home';
import { Kbd, toast, useDebounced } from './ui';

export interface Command {
  id: string;
  label: string;
  section: string;
  hint?: string;
  keywords?: string;
  run: () => unknown;
}

/**
 * Subsequence match with bonuses for word starts and runs. Returns -1 when the query
 * letters don't all appear in order.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t.includes(q)) return 1000 - t.indexOf(q) * 2 - t.length * 0.1 + (t.startsWith(q) ? 200 : 0);
  let score = 0, ti = 0, run = 0;
  for (const ch of q) {
    if (ch === ' ') { run = 0; continue; }
    const i = t.indexOf(ch, ti);
    if (i < 0) return -1;
    const wordStart = i === 0 || /[\s›>/_-]/.test(t[i - 1]);
    run = i === ti ? run + 1 : 0;
    score += 10 + (wordStart ? 15 : 0) + run * 5 - Math.min(i - ti, 10);
    ti = i + 1;
  }
  return score - t.length * 0.1;
}

const PAGES: [string, string, string][] = [
  ['/', 'Home', 'g h'], ['/study', 'Study', 'g s'], ['/analytics', 'Analytics', 'g y'], ['/library', 'Library', 'g l'],
  ['/library/new', 'New question', ''], ['/review', 'Drafts', 'g d'], ['/grades', 'Grading', 'g g'], ['/tags', 'Tags', 'g t'],
  ['/import', 'Import', ''], ['/activity', 'Agent activity', 'g a'], ['/settings', 'Settings', 'g ,'],
];

export function Palette({ open, onClose, toggleTheme }: { open: boolean; onClose: () => void; toggleTheme: () => void }) {
  const [, nav] = useLocation();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { data: tags } = useApi<TagNode[]>(open ? '/tags' : null);
  const { data: recs } = useApi<Recommendation[]>(open ? '/recommendations' : null);
  const dq = useDebounced(q.trim(), 120);
  const { data: found } = useApi<{ items: Question[] }>(open && dq.length >= 2 ? `/questions?q=${encodeURIComponent(dq)}&limit=8` : null);

  useEffect(() => {
    if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 0); }
  }, [open]);

  const go = (to: string) => () => nav(to);
  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [];
    for (const r of recs ?? []) if (r.session) out.push({ id: 'rec:' + r.title, section: 'Study next', label: r.title, hint: r.reason, run: () => startSession(nav, r.session!) });
    const modes: Mode[] = ['srs', 'adaptive', 'weak', 'practice'];
    for (const m of modes) out.push({ id: 'mode:' + m, section: 'Start', label: `Start ${MODE_LABELS[m].toLowerCase()}`, keywords: 'session quiz study', run: () => startSession(nav, { mode: m, limit: 20 }) });
    out.push({ id: 'mode:exam', section: 'Start', label: 'Set up an exam', keywords: 'test timed', run: go('/study?mode=exam') });
    for (const [href, label, keys] of PAGES) out.push({ id: 'page:' + href, section: 'Go to', label, hint: keys, run: go(href) });
    out.push({ id: 'act:theme', section: 'Actions', label: 'Toggle light / dark', hint: '\\', keywords: 'theme mode', run: toggleTheme });
    out.push({ id: 'act:export', section: 'Actions', label: 'Export questions (JSON)', keywords: 'download backup', run: () => { location.href = '/api/export/json'; } });
    out.push({ id: 'act:db', section: 'Actions', label: 'Download full database copy', keywords: 'backup sqlite', run: () => { location.href = '/api/export/db'; } });
    out.push({
      id: 'act:backup', section: 'Actions', label: 'Back up now', keywords: 'snapshot',
      run: async () => { try { await api.post('/backups', {}); toast('Backup written', 'good'); } catch (e: any) { toast(e.message, 'bad'); } },
    });
    out.push({ id: 'act:fit', section: 'Actions', label: 'Fit schedule to my history', keywords: 'fsrs optimize weights', run: go('/settings') });
    const names = new Map((tags ?? []).map((t) => [t.path, t.name]));
    for (const t of tags ?? []) {
      if (!t.subtree_questions) continue;
      out.push({ id: 'tag:' + t.path, section: 'Practice a tag', label: tagLabel(t.path, names), hint: `${t.subtree_questions}`, keywords: 'practice', run: () => startSession(nav, { mode: 'practice', tags: [t.path], limit: 15 }) });
    }
    return out;
  }, [recs, tags, nav, toggleTheme]);

  const items = useMemo(() => {
    const query = q.trim();
    let list: (Command & { score: number })[];
    if (!query) list = commands.filter((c) => c.section !== 'Practice a tag').map((c) => ({ ...c, score: 0 }));
    else
      list = commands
        .map((c) => ({ ...c, score: Math.max(fuzzyScore(query, c.label), c.keywords ? fuzzyScore(query, c.keywords) - 300 : -1) }))
        .filter((c) => c.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 30);
    const qs: (Command & { score: number })[] = (dq.length >= 2 && dq === query ? found?.items ?? [] : []).map((x) => ({
      id: 'q:' + x.id, section: 'Questions', label: plain(x.prompt).slice(0, 140), hint: `#${x.id}`, score: -1, run: go(`/library/${x.id}`),
    }));
    // group by section, keeping each section's best-first order
    const order: string[] = [];
    for (const c of list) if (!order.includes(c.section)) order.push(c.section);
    const grouped = order.flatMap((s) => list.filter((c) => c.section === s));
    return [...grouped, ...qs];
  }, [q, dq, commands, found]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;
  const pick = (c?: Command) => { if (!c) return; onClose(); c.run(); };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="fade-in w-full max-w-xl rounded-xl border border-line-strong bg-panel overflow-hidden shadow-2xl">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Type a command, page, tag or question…"
          className="w-full h-12 px-4 bg-transparent outline-none text-[14.5px] border-b border-line placeholder:text-faint"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
            else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); pick(items[sel]); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
          }}
        />
        <div ref={listRef} className="max-h-[56vh] overflow-y-auto py-1.5">
          {items.length === 0 && <div className="px-4 py-6 text-center text-muted text-[13px]">{dq.length >= 2 && !found ? 'Searching…' : 'No matches'}</div>}
          {items.map((c, i) => (
            <div key={c.id}>
              {(i === 0 || items[i - 1].section !== c.section) && <div className="px-4 pt-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-faint">{c.section}</div>}
              <button
                data-i={i}
                onMouseMove={() => sel !== i && setSel(i)}
                onClick={() => pick(c)}
                className={`w-full flex items-center justify-between gap-4 px-4 h-9 text-left text-[13.5px] ${i === sel ? 'bg-hover' : ''}`}
              >
                <span className="truncate">{c.label}</span>
                {c.hint && <span className={`shrink-0 text-[12px] text-faint ${c.section === 'Study next' ? 'truncate max-w-[50%]' : 'font-mono'}`}>{c.hint}</span>}
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-4 px-4 h-9 border-t border-line text-[11.5px] text-faint">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
          <span className="flex items-center gap-1"><Kbd>Enter</Kbd> run</span>
          <span className="flex items-center gap-1"><Kbd>Esc</Kbd> close</span>
        </div>
      </div>
    </div>
  );
}
