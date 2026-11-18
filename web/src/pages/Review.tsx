import { useEffect, useState } from 'react';
import { api, useApi, invalidate, ago, type Question } from '../lib/api';
import { useKeys } from '../lib/keys';
import { MdLine } from '../lib/md';
import { Button, Card, Empty, PageHeader, Badge, toast, SourceLine } from '../components/ui';
import { QuestionView, QuestionForm, toDraft, toPayload, type Draft } from './Editor';

/** Approve or reject questions your agent added. a = approve, x = reject, e = edit, j/k = move. */
export default function Review() {
  const { data, refetch } = useApi<{ total: number; items: Question[] }>('/questions?status=draft&limit=200');
  const [i, setI] = useState(0);
  const [editing, setEditing] = useState<Draft | null>(null);
  const items = data?.items ?? [];
  const q = items[Math.min(i, items.length - 1)];
  useEffect(() => { setEditing(null); }, [q?.id]);

  const act = async (status: 'active' | 'archived', ids = q ? [q.id] : []) => {
    if (!ids.length) return;
    await api.post('/questions/status', { ids, status });
    toast(status === 'active' ? `Approved ${ids.length > 1 ? ids.length + ' questions' : ''}`.trim() : 'Rejected', 'neutral', ids.length === 1 ? {
      label: 'Undo',
      run: async () => { await api.post('/questions/status', { ids, status: 'draft' }); invalidate('/questions', '/home'); refetch(); },
    } : undefined);
    invalidate('/questions', '/home', '/tags');
    await refetch();
  };

  const saveEdit = async () => {
    if (!editing || !q) return;
    try {
      await api.patch(`/questions/${q.id}`, toPayload(editing));
      setEditing(null);
      await refetch();
      toast('Saved');
    } catch (e: any) { toast(e.message, 'bad'); }
  };

  const nav = (d: number) => setI((n) => Math.max(0, Math.min(items.length - 1, n + d)));
  useKeys(
    editing
      ? { 'mod+s': saveEdit, Escape: () => setEditing(null) }
      : { a: () => act('active'), x: () => act('archived'), e: () => q && setEditing(toDraft(q)), j: () => nav(1), k: () => nav(-1), ArrowDown: () => nav(1), ArrowUp: () => nav(-1) },
    { allowInInput: ['Escape'] },
  );

  return (
    <div className="fade-in">
      <PageHeader
        title="Drafts"
        sub="Questions your AI agent added. Approve them to add them to your reviews."
        actions={items.length > 1 && <Button onClick={() => act('active', items.map((x) => x.id))}>Approve all {items.length}</Button>}
      />
      {data && !items.length ? (
        <Empty title="No drafts">When an agent adds questions, they wait here for your approval. You can turn this off in Settings.</Empty>
      ) : q ? (
        <div className="grid grid-cols-[260px_1fr] gap-5 max-lg:grid-cols-1">
          <div className="rounded-xl border border-line bg-panel overflow-hidden max-h-[70vh] overflow-y-auto max-lg:hidden">
            {items.map((it, k) => (
              <button key={it.id} onClick={() => setI(k)} className={`w-full text-left px-3 py-2.5 text-[12.5px] ${k ? 'border-t border-line' : ''} ${it.id === q.id ? 'bg-hover' : 'hover:bg-hover'}`}>
                <MdLine src={it.prompt} />
                <div className="text-faint text-[11.5px] mt-0.5">{ago(it.created_at)}</div>
              </button>
            ))}
          </div>
          <Card className="p-6">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2 text-[12.5px] text-muted whitespace-nowrap min-w-0">
                <span>{Math.min(i, items.length - 1) + 1} of {items.length}</span>
                <span className="text-faint">· #{q.id} · from {q.created_by.replace('agent:', '')}</span>
                {q.near_duplicate_of && <Badge tone="warn">similar to #{q.near_duplicate_of.join(', #')}</Badge>}
              </div>
              <div className="flex gap-2">
                {editing ? (
                  <>
                    <Button variant="ghost" onClick={() => setEditing(null)} kbd="Esc">Cancel</Button>
                    <Button variant="primary" onClick={saveEdit} kbd="Ctrl S">Save</Button>
                  </>
                ) : (
                  <>
                    <Button variant="ghost" onClick={() => setEditing(toDraft(q))} kbd="e">Edit</Button>
                    <Button variant="danger" onClick={() => act('archived')} kbd="x">Reject</Button>
                    <Button variant="primary" onClick={() => act('active')} kbd="a">Approve</Button>
                  </>
                )}
              </div>
            </div>
            {editing ? <QuestionForm draft={editing} onChange={setEditing} /> : <QuestionView d={toDraft(q)} />}
            {!editing && <SourceLine source={q.source} citation={q.citation} className="mt-4" />}
          </Card>
        </div>
      ) : null}
    </div>
  );
}
