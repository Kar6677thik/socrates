import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { api, useApi, invalidate, ago } from '../lib/api';
import { Button, Card, Field, PageHeader, CopyBox, Segmented, Badge, toast } from '../components/ui';

interface S { new_per_day: number; reviews_per_day: number; retention: number; agent_drafts: boolean }
interface Mcp { token: string; http_url: string; path_token_url: string; stdio_command: { command: string; args: string[] }; claude_code: string }

export default function Settings() {
  const { data } = useApi<S>('/settings');
  const { data: mcp } = useApi<Mcp>('/mcp-info');
  const [s, setS] = useState<S | null>(null);
  const [client, setClient] = useState<'claude-code' | 'claude-desktop' | 'chatgpt' | 'other'>('claude-code');
  useEffect(() => { if (data && !s) setS(data); }, [data, s]);

  const save = async () => {
    try {
      setS(await api.patch<S>('/settings', s));
      invalidate('/home', '/settings');
      toast('Settings saved', 'good');
    } catch (e: any) { toast(e.message, 'bad'); }
  };

  const desktop = mcp && JSON.stringify({ mcpServers: { socrates: mcp.stdio_command } }, null, 2);

  return (
    <div className="fade-in max-w-2xl">
      <PageHeader title="Settings" />

      <h2 className="font-medium mb-1">Connect an AI agent</h2>
      <p className="text-muted text-[13px] mb-4">The agent can add and edit questions, grade written answers and read your performance to target weak spots. Every change shows up in Agent activity.</p>
      <Segmented
        value={client}
        onChange={setClient}
        options={[
          { value: 'claude-code', label: 'Claude Code' },
          { value: 'claude-desktop', label: 'Claude Desktop' },
          { value: 'chatgpt', label: 'ChatGPT' },
          { value: 'other', label: 'Other (HTTP)' },
        ]}
      />
      {mcp && (
        <Card className="p-5 mt-3 space-y-4 text-[13px]">
          {client === 'claude-code' && (
            <>
              <p className="text-muted">Run once in a terminal. Uses the local stdio server, no token needed.</p>
              <CopyBox text={mcp.claude_code} />
            </>
          )}
          {client === 'claude-desktop' && (
            <>
              <p className="text-muted">Settings → Developer → Edit config, add this to <code className="font-mono">claude_desktop_config.json</code>, then restart Claude Desktop.</p>
              <CopyBox text={desktop!} />
            </>
          )}
          {client === 'chatgpt' && (
            <>
              <p className="text-muted">ChatGPT needs a public HTTPS address. Keep Socrates running (<code className="font-mono">npm start</code>) and open a tunnel:</p>
              <CopyBox text="cloudflared tunnel --url http://localhost:4321" />
              <p className="text-muted">Then in ChatGPT: Settings → Connectors → Developer mode → Create, choose “No authentication”, and use this URL with your tunnel’s host in place of <code className="font-mono">localhost:4321</code>:</p>
              <CopyBox text={mcp.path_token_url.replace('http://localhost:4321', 'https://YOUR-TUNNEL.trycloudflare.com')} />
              <p className="text-faint text-[12px]">The token in the URL is the password. Only the MCP endpoint is reachable through the tunnel; the app itself stays local.</p>
            </>
          )}
          {client === 'other' && (
            <>
              <p className="text-muted">Streamable HTTP endpoint. Send the token as a bearer header.</p>
              <CopyBox label="URL" text={mcp.http_url} />
              <CopyBox label="Header" text={`Authorization: Bearer ${mcp.token}`} />
            </>
          )}
          <p className="text-faint text-[12px]">Try: “Look at my tag tree and add 10 questions on …” or “Grade my pending answers.”</p>
        </Card>
      )}

      {s && (
        <>
          <h2 className="font-medium mt-10 mb-4">Study</h2>
          <Card className="p-5 space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <Field label="New questions per day"><input className="field h-8" type="number" min={0} value={s.new_per_day} onChange={(e) => setS({ ...s, new_per_day: Number(e.target.value) })} /></Field>
              <Field label="Max reviews per day"><input className="field h-8" type="number" min={0} value={s.reviews_per_day} onChange={(e) => setS({ ...s, reviews_per_day: Number(e.target.value) })} /></Field>
            </div>
            <Field label={`Target retention · ${Math.round(s.retention * 100)}%`} hint="Probability of remembering a question when it comes up. Higher means more frequent reviews.">
              <input type="range" min={0.75} max={0.97} step={0.01} value={s.retention} onChange={(e) => setS({ ...s, retention: Number(e.target.value) })} className="w-full accent-[var(--accent)]" />
            </Field>
            <label className="flex items-center gap-2.5 text-[13px]">
              <input type="checkbox" checked={s.agent_drafts} onChange={(e) => setS({ ...s, agent_drafts: e.target.checked })} className="accent-[var(--accent)]" />
              Questions added by an agent start as drafts for me to approve
            </label>
            <Button variant="primary" onClick={save}>Save</Button>
          </Card>
        </>
      )}

      <Schedule />

      <Data />
    </div>
  );
}

interface ScheduleInfo { custom: boolean; weights: number[]; defaults: number[]; fitted_at: number | null; reviews: number; min_reviews: number }
interface Metric { log_loss: number; rmse: number }
interface Fit {
  reviews: number; cards: number; enough: boolean; fitted: number[] | null; better: boolean;
  holdout: { current: Metric; fitted: Metric; n: number } | null;
  all: { current: Metric; fitted: Metric } | null;
}

/** Fit the FSRS weights to your own review history, compare, and apply or reset. */
function Schedule() {
  const { data: info, refetch } = useApi<ScheduleInfo>('/schedule');
  const [fit, setFit] = useState<Fit | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try { setFit(await api.post<Fit>('/schedule/optimize', {})); }
    catch (e: any) { toast(e.message, 'bad'); }
    finally { setBusy(false); }
  };
  const apply = async (weights: number[] | null) => {
    try {
      const r = await api.post<{ updated: number }>('/schedule/weights', { weights });
      toast(weights ? `Applied. ${r.updated} cards rescheduled.` : 'Back to the default weights', 'good');
      setFit(null);
      invalidate('/home', '/analytics');
      refetch();
    } catch (e: any) { toast(e.message, 'bad'); }
  };
  if (!info) return null;
  const enough = info.reviews >= info.min_reviews;
  const m = fit?.holdout ?? fit?.all;

  return (
    <>
      <h2 className="font-medium mt-10 mb-1">Schedule</h2>
      <p className="text-muted text-[13px] mb-4">FSRS predicts when you will forget each question. Its default weights come from millions of other learners; fitting them to your own reviews makes the predictions, and so the intervals, match how you remember.</p>
      <Card className="p-5 space-y-4 text-[13px]">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="font-medium">{info.custom ? 'Fitted to your history' : 'Default weights'}</span>
              {info.custom && info.fitted_at && <Badge tone="accent">{ago(info.fitted_at)}</Badge>}
            </div>
            <div className="text-muted">
              {info.reviews.toLocaleString()} reviews with a gap of a day or more.{' '}
              {enough ? (info.reviews < 1000 ? 'Enough to fit; 1,000 or more gives steadier weights.' : '') : `Fitting needs ${info.min_reviews}.`}
            </div>
          </div>
          <div className="flex gap-2">
            {info.custom && <Button variant="ghost" onClick={() => apply(null)}>Reset to defaults</Button>}
            <Button onClick={run} disabled={!enough || busy}>{busy ? 'Fitting…' : 'Fit to my history'}</Button>
          </div>
        </div>

        {fit && m && fit.fitted && (
          <div className="border-t border-line pt-4 space-y-3">
            <table className="w-full text-[13px] tabular-nums">
              <thead>
                <tr className="text-faint text-[12px] text-left">
                  <th className="font-normal pb-1.5">{fit.holdout ? `On ${fit.holdout.n} reviews of cards left out of the fit` : 'On all reviews'}</th>
                  <th className="font-normal pb-1.5 text-right w-24">Current</th>
                  <th className="font-normal pb-1.5 text-right w-24">Fitted</th>
                </tr>
              </thead>
              <tbody>
                <MetricRow label="Prediction error (log loss)" a={m.current.log_loss} b={m.fitted.log_loss} fmt={(x) => x.toFixed(3)} />
                <MetricRow label="Calibration error" a={m.current.rmse} b={m.fitted.rmse} fmt={(x) => (x * 100).toFixed(1) + '%'} />
              </tbody>
            </table>
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <p className="text-muted">{fit.better ? 'The fitted weights predict your recall better. Applying them recomputes every card from its history and moves due dates to match.' : 'The fitted weights are not clearly better, so keeping the current ones is safer.'}</p>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setFit(null)}>Discard</Button>
                <Button variant={fit.better ? 'primary' : 'secondary'} onClick={() => apply(fit.fitted)}>Apply</Button>
              </div>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}

function MetricRow({ label, a, b, fmt }: { label: string; a: number; b: number; fmt: (x: number) => string }) {
  const better = b < a - 1e-4, worse = b > a + 1e-4;
  return (
    <tr className="border-t border-line">
      <td className="py-1.5 text-muted">{label}</td>
      <td className="py-1.5 text-right">{fmt(a)}</td>
      <td className={`py-1.5 text-right font-medium ${better ? 'text-good' : worse ? 'text-bad' : ''}`}>{fmt(b)}</td>
    </tr>
  );
}

interface Backups { dir: string; items: { name: string; bytes: number; at: number }[] }
const mb = (b: number) => (b < 1e6 ? `${Math.max(1, Math.round(b / 1e3))} KB` : `${(b / 1e6).toFixed(1)} MB`);

function Data() {
  const { data: backups, refetch } = useApi<Backups>('/backups');
  const backupNow = async () => {
    try { await api.post('/backups', {}); refetch(); toast('Backup written', 'good'); }
    catch (e: any) { toast(e.message, 'bad'); }
  };
  return (
    <>
      <h2 className="font-medium mt-10 mb-1">Data</h2>
      <p className="text-muted text-[13px] mb-4">Everything lives in <code className="font-mono">data/socrates.db</code>. A backup is written every day (14 kept) and before each database upgrade.</p>
      <Card className="divide-y divide-line text-[13px]">
        <Row title="Import questions" sub="Anki decks, CSV, Markdown, or a Socrates export.">
          <Link href="/import"><Button>Import…</Button></Link>
        </Row>
        <Row title="Export questions" sub="Tags, questions and their images as one JSON file. Import it here or on another machine. History is not included.">
          <a href="/api/export/json" download><Button>Export JSON</Button></a>
        </Row>
        <Row title="Download a full copy" sub="The whole database, history and schedule included. Open it with any SQLite tool, or replace data/socrates.db with it to restore (while Socrates is stopped).">
          <a href="/api/export/db" download><Button>Download .db</Button></a>
        </Row>
        <div className="px-5 py-4">
          <div className="flex items-center justify-between gap-4 mb-2">
            <div>
              <div className="font-medium">Backups</div>
              {backups && <div className="text-faint text-[12px] font-mono break-all">{backups.dir}</div>}
            </div>
            <Button variant="ghost" onClick={backupNow}>Back up now</Button>
          </div>
          {backups?.items.length ? (
            <div className="max-h-48 overflow-y-auto">
              {backups.items.map((b) => (
                <div key={b.name} className="flex justify-between py-1 text-[12.5px] border-t border-line first:border-0">
                  <span className="font-mono text-muted">{b.name}</span>
                  <span className="text-faint tabular-nums">{mb(b.bytes)} · {ago(b.at)}</span>
                </div>
              ))}
            </div>
          ) : <div className="text-faint text-[12.5px]">No backups yet.</div>}
        </div>
      </Card>
    </>
  );
}

function Row({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-5 py-4 max-sm:flex-col max-sm:items-start max-sm:gap-3">
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-muted mt-0.5">{sub}</div>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
