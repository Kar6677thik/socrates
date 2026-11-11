import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { api, useApi, invalidate, pct, tagLabel, type TagNode } from '../lib/api';
import { Button, Card, Empty, PageHeader, Field, toast, useDebounced } from '../components/ui';

export default function Tags() {
  const { data: tags = [], isLoading } = useApi<TagNode[]>('/tags');
  const names = useMemo(() => new Map(tags.map((t) => [t.path, t.name])), [tags]);
  const [sel, setSel] = useState<TagNode | null>(null);
  const [filter, setFilter] = useState('');
  const f = useDebounced(filter, 80).trim().toLowerCase();
  const shown = f ? tags.filter((t) => tagLabel(t.path, names).toLowerCase().includes(f) || t.aliases?.some((a) => a.includes(f))) : tags;
  const current = sel ? tags.find((t) => t.id === sel.id) ?? null : null;

  return (
    <div className="fade-in">
      <PageHeader title="Tags" sub={`${tags.length} tags. Names are normalized, so plurals, case and punctuation never create duplicates.`} />
      {!isLoading && !tags.length ? (
        <Empty title="No tags yet">Tags are created when you or your agent add questions.</Empty>
      ) : (
        <div className="grid grid-cols-[1fr_340px] gap-5 max-lg:grid-cols-1">
          <div>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tags" className="field mb-3 h-9" />
            <Card className="overflow-hidden">
              {shown.map((t, i) => {
                const depth = t.path.split('/').length - 1;
                return (
                  <button
                    key={t.id}
                    onClick={() => setSel(t)}
                    className={`w-full flex items-center gap-3 h-10 pr-4 text-left text-[13.5px] ${i ? 'border-t border-line' : ''} ${current?.id === t.id ? 'bg-hover' : 'hover:bg-hover'}`}
                    style={{ paddingLeft: 16 + (f ? 0 : depth * 18) }}
                  >
                    <span className="flex-1 truncate">{f ? tagLabel(t.path, names) : t.name}{t.aliases && <span className="text-faint text-[12px]"> · {t.aliases.join(', ')}</span>}</span>
                    {t.attempts ? <span className="text-[12px] text-faint tabular-nums w-12 text-right">{pct(t.accuracy)}</span> : null}
                    <span className="text-[12px] text-faint tabular-nums w-10 text-right">{t.subtree_questions}</span>
                  </button>
                );
              })}
            </Card>
          </div>
          {current && <TagPanel key={current.id} tag={current} tags={tags} names={names} onDone={() => setSel(null)} />}
        </div>
      )}
    </div>
  );
}

function TagPanel({ tag, tags, names, onDone }: { tag: TagNode; tags: TagNode[]; names: Map<string, string>; onDone: () => void }) {
  const [name, setName] = useState(tag.name);
  const [alias, setAlias] = useState('');
  const [parent, setParent] = useState(tag.path.includes('/') ? tag.path.slice(0, tag.path.lastIndexOf('/')) : '');
  const [target, setTarget] = useState('');
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); toast(msg); invalidate('/tags', '/questions', '/home'); } catch (e: any) { toast(e.message, 'bad'); }
  };
  const others = tags.filter((t) => t.id !== tag.id && !t.path.startsWith(tag.path + '/'));
  return (
    <Card className="p-5 h-fit sticky top-4 space-y-5">
      <div>
        <div className="font-medium">{tagLabel(tag.path, names)}</div>
        <div className="text-[12.5px] text-faint mt-0.5">{tag.questions} direct · {tag.subtree_questions} including subtags{tag.attempts ? ` · ${tag.attempts} answers · ${pct(tag.accuracy)}` : ''}</div>
        <Link href={`/library?tag=${encodeURIComponent(tag.path)}`} className="text-accent text-[12.5px]">View questions →</Link>
      </div>
      <Field label="Name">
        <div className="flex gap-2">
          <input className="field h-8" value={name} onChange={(e) => setName(e.target.value)} />
          <Button size="sm" disabled={name.trim() === tag.name} onClick={() => run(() => api.post(`/tags/${tag.id}/rename`, { name }), 'Renamed. The old name still resolves.')}>Rename</Button>
        </div>
      </Field>
      <Field label="Aliases" hint={tag.aliases?.length ? `Current: ${tag.aliases.join(', ')}` : 'Synonyms and abbreviations that resolve to this tag.'}>
        <div className="flex gap-2">
          <input className="field h-8" value={alias} placeholder="e.g. calc" onChange={(e) => setAlias(e.target.value)} />
          <Button size="sm" disabled={!alias.trim()} onClick={() => run(async () => { await api.post(`/tags/${tag.id}/alias`, { alias }); setAlias(''); }, 'Alias added')}>Add</Button>
        </div>
      </Field>
      <Field label="Parent">
        <div className="flex gap-2">
          <select className="field h-8" value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">(top level)</option>
            {others.map((t) => <option key={t.id} value={t.path}>{tagLabel(t.path, names)}</option>)}
          </select>
          <Button size="sm" onClick={() => run(() => api.post(`/tags/${tag.id}/move`, { parent: parent || null }), 'Moved')}>Move</Button>
        </div>
      </Field>
      <Field label="Merge into" hint="Questions and subtags move to the target. This name becomes an alias.">
        <div className="flex gap-2">
          <select className="field h-8" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose a tag…</option>
            {others.map((t) => <option key={t.id} value={t.id}>{tagLabel(t.path, names)}</option>)}
          </select>
          <Button size="sm" variant="danger" disabled={!target} onClick={() => run(async () => { await api.post('/tags/merge', { source_id: tag.id, target_id: Number(target) }); onDone(); }, 'Merged')}>Merge</Button>
        </div>
      </Field>
      {tag.subtree_questions === 0 && (
        <Button size="sm" variant="ghost" onClick={() => run(async () => { await api.del(`/tags/${tag.id}`); onDone(); }, 'Deleted')}>Delete unused tag</Button>
      )}
    </Card>
  );
}
