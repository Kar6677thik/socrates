import { api, useApi, invalidate, ago, fmtMs, tagLabel, useTagNames } from '../lib/api';
import { Md } from '../lib/md';
import { Button, Card, Empty, PageHeader, CopyBox, toast } from '../components/ui';

interface Pending {
  attempt_id: number;
  question_id: number;
  prompt: string;
  model_answer: string;
  rubric: { criterion: string; points: number }[] | null;
  tags: string[];
  response: string;
  answered_at: number;
  time_ms: number;
}

const SELF = [
  { score: 0, label: 'Wrong' },
  { score: 0.5, label: 'Partly' },
  { score: 0.8, label: 'Mostly' },
  { score: 1, label: 'Fully' },
];

export default function Grades() {
  const { data, refetch } = useApi<Pending[]>('/grades/pending');
  const names = useTagNames();
  const grade = async (id: number, score: number) => {
    try {
      await api.post(`/grades/${id}`, { score });
      invalidate('/home');
      await refetch();
    } catch (e: any) { toast(e.message, 'bad'); }
  };
  return (
    <div className="fade-in max-w-3xl">
      <PageHeader title="Grading" sub="Written answers waiting for a grade. Their review schedule updates once graded." />
      {data && data.length > 0 && (
        <div className="mb-6">
          <CopyBox label="Ask your agent to grade these:" text="Grade my pending answers in Socrates." />
        </div>
      )}
      {data && !data.length ? (
        <Empty title="Nothing to grade">Written answers you leave ungraded show up here for you or your AI agent.</Empty>
      ) : (
        <div className="space-y-4">
          {data?.map((p) => (
            <Card key={p.attempt_id} className="p-5">
              <div className="text-[12px] text-faint mb-2">{p.tags.map((t) => tagLabel(t, names)).join(', ')} · {ago(p.answered_at)} · {fmtMs(p.time_ms)}</div>
              <Md src={p.prompt} className="text-[14.5px]" />
              <div className="grid grid-cols-2 gap-4 mt-4 max-md:grid-cols-1">
                <div>
                  <div className="text-[12px] text-faint mb-1">Your answer</div>
                  <div className="text-[13.5px] whitespace-pre-wrap">{p.response || <span className="text-faint">(empty)</span>}</div>
                </div>
                <div>
                  <div className="text-[12px] text-faint mb-1">Model answer</div>
                  <Md src={p.model_answer} className="text-[13.5px] text-muted" />
                  {p.rubric && <ul className="mt-2 text-[12.5px] text-faint">{p.rubric.map((r, i) => <li key={i}>· {r.criterion} ({r.points})</li>)}</ul>}
                </div>
              </div>
              <div className="flex gap-1.5 mt-4 pt-4 border-t border-line">
                {SELF.map((s) => <Button key={s.label} size="sm" onClick={() => grade(p.attempt_id, s.score)}>{s.label}</Button>)}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
