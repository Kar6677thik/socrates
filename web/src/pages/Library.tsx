import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { useApi, tagLabel, useTagNames, TYPES, TYPE_LABELS, api, invalidate, ago, type Question, type QType, type TagNode } from '../lib/api';
import { MdLine } from '../lib/md';
import { useKeys } from '../lib/keys';
import { Button, Chip, Badge, Empty, PageHeader, useDebounced, toast, Kbd } from '../components/ui';
import { TagInput } from '../components/TagInput';

const STATUSES = ['active', 'draft', 'suspended', 'archived'] as const;

export default function Library() {
  const [, nav] = useLocation();
  const search = new URLSearchParams(useSearch());
  const [q, setQ] = useState(search.get('q') ?? '');
  const [types, setTypes] = useState<QType[]>([]);
  const [status, setStatus] = useState<string[]>([]);
  // ?tag= takes a path, or a tag id (the links in MCP results and study tasks), resolved once the tag list loads.
  const tagParam = search.get('tag');
  const tagIdParam = tagParam && /^\d+$/.test(tagParam) ? Number(tagParam) : null;
  const [tags, setTags] = useState<string[]>(tagParam && tagIdParam === null ? [tagParam] : []);
  const { data: tagList } = useApi<TagNode[]>(tagIdParam !== null ? '/tags' : null);
  useEffect(() => {
    const t = tagIdParam !== null && tagList?.find((x) => x.id === tagIdParam);
    if (t) setTags([t.path]);
  }, [tagList, tagIdParam]);
  const [flagged, setFlagged] = useState(search.get('flagged') === '1');
  const [page, setPage] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const dq = useDebounced(q, 120);
  const names = useTagNames();
  const PAGE = 50;

  const url = useMemo(() => {
    const p = new URLSearchParams();
    if (dq) p.set('q', dq);
    if (types.length) p.set('types', types.join(','));
    if (status.length) p.set('status', status.join(','));
    if (tags.length) p.set('tags', tags.join(','));
    if (flagged) p.set('flagged', '1');
    p.set('limit', String(PAGE));
    p.set('offset', String(page * PAGE));
    return `/questions?${p}`;
  }, [dq, types, status, tags, flagged, page]);
  const { data } = useApi<{ total: number; items: Question[] }>(url);
  const items = data?.items ?? [];
  useEffect(() => { setPage(0); setCursor(0); }, [dq, types, status, tags, flagged]);

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  useKeys({
    '/': () => input.current?.focus(),
    n: () => nav('/library/new'),
    j: () => setCursor((c) => Math.min(items.length - 1, c + 1)),
    k: () => setCursor((c) => Math.max(0, c - 1)),
    ArrowDown: () => setCursor((c) => Math.min(items.length - 1, c + 1)),
    ArrowUp: () => setCursor((c) => Math.max(0, c - 1)),
    Enter: () => { if (items[cursor]) nav(`/library/${items[cursor].id}`); },
    ' ': () => { const it = items[cursor]; if (it) setSelected((s) => { const n = new Set(s); n.has(it.id) ? n.delete(it.id) : n.add(it.id); return n; }); },
  });

  const bulk = async (st: string) => {
    await api.post('/questions/status', { ids: [...selected], status: st });
    toast(`${selected.size} question${selected.size === 1 ? '' : 's'} set to ${st}`);
    setSelected(new Set());
    invalidate('/questions', '/home', '/tags');
  };

  return (
    <div className="fade-in">
      <PageHeader
        title="Library"
        sub={data ? `${data.total} question${data.total === 1 ? '' : 's'}` : ' '}
        actions={<><Link href="/import"><Button variant="ghost">Import</Button></Link><Link href="/library/new"><Button variant="primary" kbd="n">New question</Button></Link></>}
      />
      <div className="space-y-3 mb-5">
        <div className="relative">
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') (e.target as HTMLInputElement).blur(); if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); } }}
            placeholder="Search questions"
            className="field pl-3 pr-10 h-9"
          />
          <Kbd className="absolute right-3 top-1/2 -translate-y-1/2">/</Kbd>
        </div>
        <div className="flex flex-wrap gap-1.5 items-center">
          {TYPES.map((t) => <Chip key={t} active={types.includes(t)} onClick={() => setTypes(toggle(types, t))}>{TYPE_LABELS[t]}</Chip>)}
          <span className="w-px h-5 bg-line mx-1" />
          {STATUSES.map((s) => <Chip key={s} active={status.includes(s)} onClick={() => setStatus(toggle(status, s))}>{s}</Chip>)}
          <Chip active={flagged} onClick={() => setFlagged(!flagged)}>flagged</Chip>
        </div>
        <TagInput value={tags} onChange={setTags} placeholder="Filter by tag" allowCreate={false} />
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-2 mb-3 text-[13px]">
          <span className="text-muted">{selected.size} selected</span>
          <Button size="sm" onClick={() => bulk('active')}>Activate</Button>
          <Button size="sm" onClick={() => bulk('suspended')}>Suspend</Button>
          <Button size="sm" variant="danger" onClick={() => bulk('archived')}>Archive</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      {data && items.length === 0 ? (
        <Empty title={data.total === 0 && !dq && !types.length && !tags.length ? 'No questions yet' : 'No matches'}>
          {data.total === 0 && !dq ? 'Write one, or ask your AI agent to add some through MCP.' : 'Try a different search or fewer filters.'}
        </Empty>
      ) : (
        <div className="rounded-xl border border-line bg-panel overflow-hidden">
          {items.map((it, i) => (
            <div
              key={it.id}
              onMouseEnter={() => setCursor(i)}
              className={`flex items-center gap-3 px-4 h-[52px] ${i ? 'border-t border-line' : ''} ${cursor === i ? 'bg-hover' : ''}`}
            >
              <input
                type="checkbox"
                checked={selected.has(it.id)}
                onChange={() => setSelected((s) => { const n = new Set(s); n.has(it.id) ? n.delete(it.id) : n.add(it.id); return n; })}
                className="accent-[var(--accent)]"
                aria-label="Select"
              />
              <Link href={`/library/${it.id}`} className="flex-1 min-w-0 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <MdLine src={it.prompt} className="text-[13.5px]" />
                  <div className="truncate text-[12px] text-faint">{it.tags.map((t) => tagLabel(t.path, names)).join(' · ')}</div>
                </div>
                {it.flagged_reason && <Badge tone="warn">flagged</Badge>}
                {it.near_duplicate_of && <Badge tone="warn">near duplicate</Badge>}
                {it.status !== 'active' && <Badge>{it.status}</Badge>}
                <span className="text-[12px] text-faint w-28 text-right shrink-0">{TYPE_LABELS[it.type]}</span>
                <span className="text-[12px] text-faint w-16 text-right shrink-0">{ago(it.updated_at)}</span>
              </Link>
            </div>
          ))}
        </div>
      )}
      {data && data.total > PAGE && (
        <div className="flex items-center justify-end gap-2 mt-3 text-[12.5px] text-muted">
          <span>{page * PAGE + 1}–{Math.min(data.total, (page + 1) * PAGE)} of {data.total}</span>
          <Button size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</Button>
          <Button size="sm" disabled={(page + 1) * PAGE >= data.total} onClick={() => setPage(page + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}
