import { useState } from 'react';
import { api, useApi, invalidate, ago } from '../lib/api';
import { Button, Card, Empty, PageHeader, Badge, toast } from '../components/ui';

interface Entry {
  id: number;
  at: number;
  actor: string;
  tool: string;
  args: any;
  result: any;
  undo: any;
  reverted_at: number | null;
}

function summary(e: Entry): string {
  const r = e.result ?? {};
  switch (e.tool) {
    case 'add_questions': return Object.entries(r.summary ?? {}).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(', ');
    case 'create_tags': return (r.results ?? []).map((x: any) => `${x.path}: ${x.status}`).join(' · ');
    case 'update_question': return `#${r.id} → v${r.version} (${r.edit_kind}${r.schedule_reset ? ', schedule reset' : ''})`;
    case 'submit_grades': return `${(r.results ?? []).length} graded`;
    case 'merge_tags': return `${r.merged} → ${r.into}`;
    case 'set_question_status': return `${r.changed} changed to ${e.args?.status}`;
    case 'create_quiz': return `${r.questions} questions`;
    default: return '';
  }
}

export default function Activity() {
  const { data, refetch } = useApi<Entry[]>('/audit?limit=200');
  const [open, setOpen] = useState<number | null>(null);
  const revert = async (id: number) => {
    try {
      await api.post(`/audit/${id}/revert`);
      toast('Reverted');
      invalidate('/questions', '/tags', '/home');
      refetch();
    } catch (e: any) { toast(e.message, 'bad'); }
  };
  return (
    <div className="fade-in">
      <PageHeader title="Agent activity" sub="Every change made through MCP. Adds, edits, status changes and new tags can be reverted." />
      {data && !data.length ? (
        <Empty title="No agent activity yet">Connect Claude or ChatGPT in Settings.</Empty>
      ) : (
        <Card className="overflow-hidden">
          {data?.map((e, i) => (
            <div key={e.id} className={i ? 'border-t border-line' : ''}>
              <div className="flex items-center gap-3 px-4 h-11 text-[13px]">
                <button className="flex-1 min-w-0 flex items-center gap-3 text-left" onClick={() => setOpen(open === e.id ? null : e.id)}>
                  <span className="font-mono text-[12.5px] w-40 shrink-0">{e.tool}</span>
                  <span className="truncate text-muted">{summary(e)}</span>
                </button>
                {e.reverted_at && <Badge>reverted</Badge>}
                <span className="text-faint text-[12px] shrink-0">{e.actor.replace('agent:', '')}</span>
                <span className="text-faint text-[12px] w-16 text-right shrink-0">{ago(e.at)}</span>
                {e.undo && !e.reverted_at && <Button size="sm" variant="ghost" onClick={() => revert(e.id)}>Revert</Button>}
              </div>
              {open === e.id && (
                <div className="grid grid-cols-2 gap-3 px-4 pb-4 max-md:grid-cols-1">
                  <pre className="text-[11.5px] font-mono bg-elev border border-line rounded-lg p-3 overflow-auto max-h-80">{JSON.stringify(e.args, null, 2)}</pre>
                  <pre className="text-[11.5px] font-mono bg-elev border border-line rounded-lg p-3 overflow-auto max-h-80">{JSON.stringify(e.result, null, 2)}</pre>
                </div>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
