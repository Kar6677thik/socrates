import { useMemo, useRef, useState } from 'react';
import { api, useApi, invalidate, tagLabel, type TagNode } from '../lib/api';
import { toast } from './ui';

interface Resolution {
  tag_id: number | null;
  path: string | null;
  missing: string[];
  suggestions: { id: number; path: string; name: string; score: number; reason: string }[];
}

/**
 * Tag paths with autocomplete from the existing pool. Typing a name that does not exist shows
 * the closest existing tags first; creating a new tag is an explicit second step.
 */
export function TagInput({ value, onChange, placeholder = 'Add tag…', autoFocus, allowCreate = true }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; autoFocus?: boolean; allowCreate?: boolean }) {
  const { data: tags = [] } = useApi<TagNode[]>('/tags');
  const names = useMemo(() => new Map(tags.map((t) => [t.path, t.name])), [tags]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [res, setRes] = useState<Resolution | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase().replace(/\s*(>|›)\s*/g, '/').replace(/\s+/g, '-');
    if (!s) return [];
    return tags
      .filter((t) => !value.includes(t.path))
      .map((t) => {
        const label = tagLabel(t.path, names).toLowerCase();
        const leaf = t.path.split('/').pop()!;
        const score = leaf.startsWith(s) ? 3 : t.path.includes(s) ? 2 : label.includes(q.trim().toLowerCase()) || t.aliases?.some((a) => a.includes(s)) ? 1 : 0;
        return { t, score };
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score || a.t.path.length - b.t.path.length)
      .slice(0, 8)
      .map((m) => m.t);
  }, [q, tags, value, names]);

  const add = (path: string) => {
    if (!value.includes(path)) onChange([...value, path]);
    setQ('');
    setRes(null);
    setSel(0);
    input.current?.focus();
  };

  const tryCreate = async () => {
    const text = q.trim();
    if (!text) return;
    const r = await api.get<Resolution>(`/tags/resolve?path=${encodeURIComponent(text)}`);
    if (r.tag_id) return add(r.path!);
    setRes(r);
  };

  const create = async (force = false) => {
    try {
      const out = await api.post<{ tag: { path: string } }>('/tags', { path: q.trim(), force });
      invalidate('/tags');
      add(out.tag.path);
    } catch (e: any) {
      toast(e.message, 'bad');
    }
  };

  return (
    <div className="relative">
      <div className="field flex flex-wrap items-center gap-1.5 min-h-[36px] py-1.5 cursor-text" onClick={() => input.current?.focus()}>
        {value.map((p) => (
          <span key={p} className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded bg-elev text-[12.5px]">
            {tagLabel(p, names)}
            <button type="button" className="text-faint hover:text-text px-0.5" onClick={() => onChange(value.filter((x) => x !== p))} aria-label={`Remove ${p}`}>×</button>
          </span>
        ))}
        <input
          ref={input}
          autoFocus={autoFocus}
          value={q}
          placeholder={value.length ? '' : placeholder}
          onChange={(e) => { setQ(e.target.value); setSel(0); setRes(null); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, Math.max(0, matches.length))); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === 'Enter' && q.trim()) {
              e.preventDefault();
              e.stopPropagation();
              if (matches[sel]) add(matches[sel].path);
              else if (allowCreate) tryCreate();
            } else if (e.key === 'Backspace' && !q && value.length) onChange(value.slice(0, -1));
          }}
          className="flex-1 min-w-[120px] outline-none h-6 text-[13px]"
        />
      </div>
      {q.trim() && (matches.length > 0 || allowCreate) && (
        <div className="absolute z-20 left-0 right-0 mt-1 rounded-lg border border-line-strong bg-panel py-1 text-[13px]">
          {matches.map((t, i) => (
            <button key={t.id} type="button" onMouseEnter={() => setSel(i)} onClick={() => add(t.path)} className={`w-full text-left px-3 py-1.5 flex justify-between ${sel === i ? 'bg-hover' : ''}`}>
              <span>{tagLabel(t.path, names)}</span>
              <span className="text-faint">{t.subtree_questions}</span>
            </button>
          ))}
          {allowCreate && !res && (
            <button type="button" onMouseEnter={() => setSel(matches.length)} onClick={tryCreate} className={`w-full text-left px-3 py-1.5 text-muted ${sel === matches.length ? 'bg-hover' : ''}`}>
              Use “{q.trim()}”… <span className="text-faint">(use &gt; for hierarchy)</span>
            </button>
          )}
          {res && (
            <div className="px-3 py-2 border-t border-line">
              {res.suggestions.length > 0 ? (
                <>
                  <div className="text-muted mb-1.5">Similar tags already exist:</div>
                  {res.suggestions.map((s) => (
                    <button key={s.id} type="button" onClick={() => add(s.path)} className="w-full text-left px-2 py-1 rounded hover:bg-hover flex justify-between">
                      <span>{tagLabel(s.path, names)}</span>
                      <span className="text-faint text-[12px]">{s.reason}</span>
                    </button>
                  ))}
                  <button type="button" onClick={() => create(true)} className="mt-1.5 text-[12.5px] text-faint hover:text-text">Create “{res.missing.join(' › ')}” anyway</button>
                </>
              ) : (
                <button type="button" onClick={() => create(false)} className="text-accent">
                  Create new tag “{[...(res.path ? [tagLabel(res.path, names)] : []), ...res.missing].join(' › ')}”
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
