import { useState, type ReactNode } from 'react';
import { useLocation } from 'wouter';
import { useApi, pct, fmtMs, tagLabel, useTagNames, TYPE_LABELS, type QType } from '../lib/api';
import { Card, Empty, PageHeader, Segmented } from '../components/ui';
import { TagInput } from '../components/TagInput';
import { LineChart, BarChart, Scatter, Legend, Meter, pctTick } from '../components/charts';
import { startSession } from './Home';

interface A {
  window_days: number;
  totals: { attempts: number; accuracy: number | null; time_ms: number; days: number; hint_rate: number | null; streak: { current: number; best: number } };
  daily: { day: string; n: number; acc: number; avg_ms: number }[];
  by_type: { k: QType; n: number; acc: number; avg_ms: number }[];
  by_difficulty: { k: number; n: number; acc: number; avg_ms: number }[];
  by_hour: { k: number; n: number; acc: number }[];
  confidence: { k: number; n: number; acc: number }[];
  calibration: { k: number; n: number; predicted: number; actual: number }[];
  retention: { k: number; n: number; actual: number; predicted: number | null }[];
  hesitation: { k: number; n: number; acc: number }[];
  changes: { k: number; n: number; acc: number }[];
  speed: { path: string; name: string; n: number; acc: number; avg_ms: number }[];
  mastery: { id: number; path: string; name: string; attempts: number; mastery: number; recent_accuracy: number | null; trend: number | null; avg_ms: number | null; confident_wrong: number }[];
}

const RET_LABELS = ['<1d', '1–3d', '3–7d', '1–2w', '2–4w', '1–3mo', '3mo+'];
const HES_LABELS = ['<2s', '2–5s', '5–10s', '10–20s', '20s+'];
const CONF_LABELS = ['Guess', 'Unsure', 'Likely', 'Sure'];

/** Card with a chart/table toggle (the table is the accessible view of the same numbers). */
function ChartCard({ title, sub, legend, rows, children, className = '' }: { title: string; sub?: string; legend?: ReactNode; rows?: (string | number)[][]; children: ReactNode; className?: string }) {
  const [table, setTable] = useState(false);
  return (
    <Card className={`p-5 ${className}`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="font-medium text-[13.5px]">{title}</div>
          {sub && <div className="text-[12px] text-faint mt-0.5">{sub}</div>}
        </div>
        {rows && <button onClick={() => setTable(!table)} className="text-[12px] text-faint hover:text-text shrink-0">{table ? 'Chart' : 'Table'}</button>}
      </div>
      {legend && !table && <div className="mb-2">{legend}</div>}
      {table && rows ? (
        <div className="max-h-[220px] overflow-auto text-[12.5px]">
          <table className="w-full">
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={i === 0 ? 'text-faint' : 'border-t border-line'}>
                  {r.map((c, j) => <td key={j} className={`py-1 ${j ? 'text-right tabular-nums' : ''}`}>{c}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : children}
    </Card>
  );
}

function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div>
      <div className="text-[12px] text-muted">{label}</div>
      <div className="text-[22px] font-semibold tabular-nums tracking-[-0.02em] mt-0.5">{value}</div>
      {sub && <div className="text-[12px] text-faint">{sub}</div>}
    </div>
  );
}

const shortDay = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export default function Analytics() {
  const [, nav] = useLocation();
  const [days, setDays] = useState('90');
  const [tags, setTags] = useState<string[]>([]);
  const names = useTagNames();
  const { data: a } = useApi<A>(`/analytics?days=${days}${tags[0] ? `&tag=${encodeURIComponent(tags[0])}` : ''}`);

  const header = (
    <PageHeader
      title="Analytics"
      sub={tags[0] ? `Filtered to ${tagLabel(tags[0], names)}` : 'All tags'}
      actions={<Segmented value={days} onChange={setDays} options={[{ value: '30', label: '30d' }, { value: '90', label: '90d' }, { value: '365', label: '1y' }]} />}
    />
  );
  const filter = <div className="mb-6 max-w-md"><TagInput value={tags} onChange={(t) => setTags(t.slice(-1))} placeholder="Filter by tag" allowCreate={false} /></div>;

  if (!a) return <div>{header}</div>;
  if (!a.totals.attempts)
    return <div className="fade-in">{header}{filter}<Empty title="No answers in this range">Study a little and your trends, forgetting curves and mastery will show up here.</Empty></div>;

  // Fill missing days so gaps read as gaps.
  const byDay = new Map(a.daily.map((d) => [d.day, d]));
  const series: { label: string; y: number | null; n?: number; detail?: ReactNode }[] = [];
  const start = new Date(a.daily[0].day + 'T12:00:00');
  const end = new Date(a.daily[a.daily.length - 1].day + 'T12:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const r = byDay.get(key);
    series.push({ label: shortDay(key), y: r ? r.acc : null, n: r?.n, detail: r ? <div className="text-faint">avg {fmtMs(Math.round(r.avg_ms))}</div> : undefined });
  }
  const weakest = a.mastery.filter((m) => m.attempts >= 3);

  return (
    <div className="fade-in">
      {header}
      {filter}

      <Card className="p-5 mb-4">
        <div className="grid grid-cols-5 gap-4 max-md:grid-cols-2">
          <Kpi label="Answers" value={a.totals.attempts} sub={`${a.totals.days} active days`} />
          <Kpi label="Accuracy" value={pct(a.totals.accuracy)} />
          <Kpi label="Study time" value={fmtMs(a.totals.time_ms)} />
          <Kpi label="Hints used" value={pct(a.totals.hint_rate)} sub="of answers" />
          <Kpi label="Streak" value={a.totals.streak.current} sub={`best ${a.totals.streak.best}`} />
        </div>
      </Card>

      <ChartCard title="Accuracy over time" sub="Daily average score" className="mb-4" rows={[['Day', 'Answers', 'Accuracy'], ...a.daily.map((d) => [d.day, d.n, pct(d.acc)])]}>
        <LineChart data={series} label="Accuracy" height={200} />
      </ChartCard>

      <div className="grid grid-cols-2 gap-4 mb-4 max-lg:grid-cols-1">
        <Card className="p-5">
          <div className="flex items-baseline justify-between mb-3">
            <div className="font-medium text-[13.5px]">Tag mastery</div>
            <div className="text-[12px] text-faint">calibrated for question difficulty · click to drill</div>
          </div>
          {weakest.length === 0 ? (
            <div className="text-muted text-[13px] py-6 text-center">Needs at least 3 answers per tag.</div>
          ) : (
            <div className="max-h-[320px] overflow-auto -mx-2">
              <div className="grid grid-cols-[1fr_90px_44px_48px] gap-3 px-2 pb-1 text-[11.5px] text-faint">
                <span>Tag</span><span>Mastery</span><span /><span className="text-right" title="Change in accuracy, last 14 days vs the 14 before">14d Δ</span>
              </div>
              {weakest.map((m) => (
                <button key={m.id} onClick={() => startSession(nav, { mode: 'weak', tags: [m.path], limit: 15 })} className="w-full grid grid-cols-[1fr_90px_44px_48px] items-center gap-3 px-2 h-9 rounded-md hover:bg-hover text-left text-[13px]">
                  <span className="truncate" title={tagLabel(m.path, names)}>{tagLabel(m.path, names)}</span>
                  <Meter value={m.mastery} />
                  <span className="tabular-nums text-right">{pct(m.mastery)}</span>
                  <span className={`tabular-nums text-right text-[12px] ${m.trend == null ? 'text-faint' : m.trend < -0.05 ? 'text-bad' : m.trend > 0.05 ? 'text-good' : 'text-faint'}`}>
                    {m.trend == null ? '–' : `${m.trend > 0 ? '+' : ''}${Math.round(m.trend * 100)}`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </Card>

        <ChartCard
          title="Speed vs accuracy"
          sub="One dot per tag · x = avg time per answer · size = answers"
          rows={[['Tag', 'Answers', 'Avg time', 'Accuracy'], ...a.speed.map((s) => [tagLabel(s.path, names), s.n, fmtMs(Math.round(s.avg_ms)), pct(s.acc)])]}
        >
          <Scatter label="Speed vs accuracy" data={a.speed.map((s) => ({ x: s.avg_ms / 1000, y: s.acc, n: s.n, label: tagLabel(s.path, names) }))} height={260} />
        </ChartCard>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4 max-lg:grid-cols-1">
        <ChartCard
          title="Forgetting curve"
          sub="Recall by time since the last review"
          legend={<Legend items={[{ label: 'Actual recall' }, { label: 'Predicted (FSRS)', dashed: true }]} />}
          rows={[['Since last review', 'Answers', 'Actual', 'Predicted'], ...a.retention.map((r) => [RET_LABELS[r.k], r.n, pct(r.actual), pct(r.predicted)])]}
        >
          {a.retention.length ? (
            <LineChart label="Actual recall" refLabel="Predicted" area={false} data={a.retention.map((r) => ({ label: RET_LABELS[r.k], y: r.actual, ref: r.predicted, n: r.n }))} />
          ) : <NoData>Appears once you review questions you have seen before.</NoData>}
        </ChartCard>
        <ChartCard
          title="Schedule calibration"
          sub="Predicted recall vs what actually happened"
          legend={<Legend items={[{ label: 'Actual' }, { label: 'Perfect calibration', dashed: true }]} />}
          rows={[['Predicted', 'Answers', 'Actual'], ...a.calibration.map((c) => [pct(c.predicted), c.n, pct(c.actual)])]}
        >
          {a.calibration.length ? (
            <LineChart label="Actual" refLabel="Predicted" area={false} data={a.calibration.map((c) => ({ label: `${c.k * 10}–${c.k * 10 + 10}%`, y: c.actual, ref: c.predicted, n: c.n }))} />
          ) : <NoData>Appears once you review questions you have seen before.</NoData>}
        </ChartCard>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-4 max-lg:grid-cols-1">
        <ChartCard title="Confidence calibration" sub="Accuracy at each confidence level" rows={[['Confidence', 'Answers', 'Accuracy'], ...a.confidence.map((c) => [CONF_LABELS[c.k - 1], c.n, pct(c.acc)])]}>
          {a.confidence.length ? <BarChart label="Accuracy" data={[1, 2, 3, 4].map((k) => { const c = a.confidence.find((x) => x.k === k); return { label: CONF_LABELS[k - 1], value: c?.acc ?? null, n: c?.n ?? 0 }; })} /> : <NoData>Rate confidence with q w e r while answering.</NoData>}
        </ChartCard>
        <ChartCard title="Difficulty" sub="Accuracy by question difficulty" rows={[['Difficulty', 'Answers', 'Accuracy'], ...a.by_difficulty.map((d) => [d.k, d.n, pct(d.acc)])]}>
          <BarChart label="Accuracy" data={[1, 2, 3, 4, 5].map((k) => { const d = a.by_difficulty.find((x) => x.k === k); return { label: String(k), value: d?.acc ?? null, n: d?.n ?? 0, sub: `Difficulty ${k}` }; })} />
        </ChartCard>
        <ChartCard title="Question type" sub="Accuracy by type" rows={[['Type', 'Answers', 'Accuracy', 'Avg time'], ...a.by_type.map((t) => [TYPE_LABELS[t.k], t.n, pct(t.acc), fmtMs(Math.round(t.avg_ms))])]}>
          <div className="space-y-2.5 pt-1">
            {a.by_type.map((t) => (
              <div key={t.k} className="grid grid-cols-[110px_1fr_40px] items-center gap-3 text-[12.5px]" title={`${t.n} answers · avg ${fmtMs(Math.round(t.avg_ms))}`}>
                <span className="text-muted truncate">{TYPE_LABELS[t.k]}</span>
                <Meter value={t.acc} />
                <span className="tabular-nums text-right">{pct(t.acc)}</span>
              </div>
            ))}
          </div>
        </ChartCard>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-4 max-lg:grid-cols-1">
        <ChartCard title="Time of day" sub="Accuracy by hour you started" rows={[['Hour', 'Answers', 'Accuracy'], ...a.by_hour.map((h) => [`${h.k}:00`, h.n, pct(h.acc)])]}>
          <BarChart label="Accuracy" data={Array.from({ length: 24 }, (_, k) => { const h = a.by_hour.find((x) => x.k === k); return { label: k % 6 === 0 ? String(k) : '', value: h?.acc ?? null, n: h?.n ?? 0, sub: `${k}:00–${k + 1}:00` }; })} />
        </ChartCard>
        <ChartCard title="Hesitation" sub="Accuracy by time to first input" rows={[['First input', 'Answers', 'Accuracy'], ...a.hesitation.map((h) => [HES_LABELS[h.k], h.n, pct(h.acc)])]}>
          <BarChart label="Accuracy" data={HES_LABELS.map((l, k) => { const h = a.hesitation.find((x) => x.k === k); return { label: l, value: h?.acc ?? null, n: h?.n ?? 0 }; })} />
        </ChartCard>
        <ChartCard title="Answer changes" sub="Accuracy by how often you switched" rows={[['Changes', 'Answers', 'Accuracy'], ...a.changes.map((c) => [c.k === 3 ? '3+' : c.k, c.n, pct(c.acc)])]}>
          <BarChart label="Accuracy" data={[0, 1, 2, 3].map((k) => { const c = a.changes.find((x) => x.k === k); return { label: k === 3 ? '3+' : String(k), value: c?.acc ?? null, n: c?.n ?? 0, sub: `${k === 3 ? '3 or more' : k} change${k === 1 ? '' : 's'}` }; })} />
        </ChartCard>
      </div>
      <p className="text-[12px] text-faint">Faded bars have fewer than 3 answers. Mastery adjusts for question difficulty, so it can differ from raw accuracy. {pctTick(0.8)} predicted success is the sweet spot the adaptive mode aims for.</p>
    </div>
  );
}

function NoData({ children }: { children: ReactNode }) {
  return <div className="h-[180px] grid place-items-center text-[13px] text-muted text-center px-6">{children}</div>;
}
