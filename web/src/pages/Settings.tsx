import { useEffect, useState } from 'react';
import { api, useApi, invalidate } from '../lib/api';
import { Button, Card, Field, PageHeader, CopyBox, Segmented, toast } from '../components/ui';

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

      <h2 className="font-medium mt-10 mb-2">Data</h2>
      <p className="text-muted text-[13px]">Everything lives in <code className="font-mono">data/socrates.db</code>. A backup is written to <code className="font-mono">data/backups/</code> every day (14 kept) and before each database upgrade.</p>
    </div>
  );
}
