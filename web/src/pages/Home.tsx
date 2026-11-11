import { useLocation, Link } from 'wouter';
import { api, useApi, pct, fmtMs, tagLabel, useTagNames, type Home } from '../lib/api';
import { useKeys } from '../lib/keys';
import { Button, Card, Empty, toast } from '../components/ui';

export async function startSession(nav: (to: string) => void, config: Record<string, unknown>) {
  try {
    const s = await api.post<{ session_id: number; questions: unknown[] }>('/sessions', config);
    if (!s.questions.length) return toast('Nothing to study with these filters.', 'neutral');
    nav(`/study/${s.session_id}`);
  } catch (e: any) {
    toast(e.message, 'bad');
  }
}

function Calendar({ days }: { days: Home['calendar'] }) {
  const map = new Map(days.map((d) => [d.day, d.n]));
  const cells: { day: string; n: number }[] = [];
  const today = new Date(Date.now() - 4 * 3600_000);
  const weeks = 20;
  const start = new Date(today);
  start.setDate(today.getDate() - ((today.getDay() + 6) % 7) - (weeks - 1) * 7);
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    cells.push({ day: key, n: d > today ? -1 : map.get(key) ?? 0 });
  }
  const max = Math.max(10, ...days.map((d) => d.n));
  return (
    <div className="grid grid-flow-col grid-rows-7 gap-[3px] w-fit">
      {cells.map((c) => (
        <div
          key={c.day}
          title={c.n >= 0 ? `${c.day}: ${c.n} answers` : ''}
          className="w-[11px] h-[11px] rounded-[2.5px]"
          style={{
            background: c.n < 0 ? 'transparent' : c.n === 0 ? 'var(--elev)' : `color-mix(in oklab, var(--accent) ${20 + Math.round((c.n / max) * 80)}%, var(--elev))`,
          }}
        />
      ))}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div>
      <div className="text-[12px] text-muted">{label}</div>
      <div className="text-[22px] font-semibold tabular-nums tracking-[-0.02em] mt-0.5">{value}</div>
      {sub && <div className="text-[12px] text-faint">{sub}</div>}
    </div>
  );
}

export default function HomePage() {
  const [, nav] = useLocation();
  const { data: h } = useApi<Home>('/home');
  const names = useTagNames();
  const reviewCount = h ? h.due + h.new_available : 0;
  useKeys({ Enter: () => { if (reviewCount) startSession(nav, { mode: 'srs' }); else nav('/study'); } });

  if (!h) return null;
  if (h.counts.active === 0 && h.counts.drafts === 0)
    return (
      <div className="max-w-xl mx-auto pt-16">
        <h1 className="text-[22px] font-semibold tracking-[-0.01em]">Welcome to Socrates</h1>
        <p className="text-muted mt-2">Your question bank is empty. Add questions yourself, or connect Claude or ChatGPT and ask it to write some for you.</p>
        <div className="flex gap-2 mt-6">
          <Link href="/settings"><Button variant="primary">Connect an AI agent</Button></Link>
          <Link href="/library/new"><Button>Write a question</Button></Link>
        </div>
        <p className="text-faint text-[12.5px] mt-6">Or load sample questions: <code className="font-mono">npm run seed</code></p>
      </div>
    );

  return (
    <div className="fade-in">
      <div className="grid grid-cols-[1.25fr_1fr] gap-4 max-lg:grid-cols-1">
        <Card className="p-6 flex flex-col">
          <div className="text-[12.5px] text-muted">Today</div>
          {reviewCount > 0 ? (
            <>
              <div className="text-[28px] font-semibold tracking-[-0.02em] mt-1">{reviewCount} to review</div>
              <div className="text-muted">{h.due} due · {h.new_available} new</div>
            </>
          ) : (
            <>
              <div className="text-[28px] font-semibold tracking-[-0.02em] mt-1">All caught up</div>
              <div className="text-muted">{h.unseen > 0 ? `New-question limit reached (${h.limits.new_per_day}/day).` : 'Nothing is due.'} Practice anything from Study.</div>
            </>
          )}
          <div className="mt-auto pt-6 flex gap-2">
            {reviewCount > 0 ? (
              <Button variant="primary" size="lg" kbd="↵" onClick={() => startSession(nav, { mode: 'srs' })}>Start review</Button>
            ) : (
              <Button variant="primary" size="lg" kbd="↵" onClick={() => nav('/study')}>Practice</Button>
            )}
            {h.weak[0] && (
              <Button size="lg" onClick={() => startSession(nav, { mode: 'practice', tags: [h.weak[0].path], limit: 15 })}>Drill weakest tag</Button>
            )}
          </div>
        </Card>
        <Card className="p-6">
          <div className="grid grid-cols-3 gap-4">
            <Stat label="Streak" value={h.streak.current} sub={`best ${h.streak.best}`} />
            <Stat label="Answered today" value={h.today.answered} sub={h.today.time_ms ? fmtMs(h.today.time_ms) : undefined} />
            <Stat label="Accuracy today" value={pct(h.today.accuracy)} />
          </div>
          <div className="mt-6 overflow-x-auto"><Calendar days={h.calendar} /></div>
        </Card>
      </div>

      {(h.counts.drafts > 0 || h.counts.pending > 0 || h.counts.flagged > 0) && (
        <div className="flex gap-2 mt-4 flex-wrap">
          {h.counts.drafts > 0 && <Link href="/review"><Button size="sm">{h.counts.drafts} drafts to approve</Button></Link>}
          {h.counts.pending > 0 && <Link href="/grades"><Button size="sm">{h.counts.pending} answers awaiting grade</Button></Link>}
          {h.counts.flagged > 0 && <Link href="/library?flagged=1"><Button size="sm">{h.counts.flagged} flagged questions</Button></Link>}
        </div>
      )}

      <div className="mt-8">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="font-medium">Weakest tags</h2>
          <span className="text-faint text-[12.5px]">last 60 days · min. 3 answers</span>
        </div>
        {h.weak.length === 0 ? (
          <Empty title="Not enough data yet">Answer a few questions and your weak spots will show up here.</Empty>
        ) : (
          <Card>
            {h.weak.map((w, i) => (
              <button
                key={w.id}
                onClick={() => startSession(nav, { mode: 'practice', tags: [w.path], limit: 15 })}
                className={`w-full flex items-center gap-4 px-5 h-12 text-left hover:bg-hover transition-colors ${i ? 'border-t border-line' : ''}`}
              >
                <span className="flex-1 truncate">{tagLabel(w.path, names)}</span>
                {w.confident_wrong > 0 && <span className="text-[12px] text-warn">{w.confident_wrong} confidently wrong</span>}
                <span className="text-[12px] text-faint w-20 text-right">{w.attempts} answers</span>
                <span className="w-28 h-1.5 rounded-full bg-elev overflow-hidden">
                  <span className="block h-full rounded-full bg-muted" style={{ width: `${Math.round(w.accuracy * 100)}%` }} />
                </span>
                <span className="w-10 text-right tabular-nums">{pct(w.accuracy)}</span>
              </button>
            ))}
          </Card>
        )}
      </div>
    </div>
  );
}
