import { serve } from '@hono/node-server';
import { App } from '../core/app.ts';
import { backupIfDue } from '../core/db.ts';
import { loadConfig } from './config.ts';
import { Owner } from './owner.ts';
import { tokenVerifier } from './oauth.ts';
import { createServers } from './http.ts';

// Fail fast on bad configuration: a deployed instance must never start half-secured.
const cfg = loadConfig();
const owner = cfg.credentialFile && cfg.totpFile ? Owner.fromFiles(cfg.credentialFile, cfg.totpFile) : null;
const verifyToken = cfg.oauth ? tokenVerifier(cfg.oauth) : null;

const app = new App();
const { ui, mcp } = createServers(app, cfg, { owner, verifyToken });

const runBackup = () => {
  try {
    backupIfDue(app.db, app.dbPath);
  } catch (e: any) {
    console.error(`[socrates] Backup failed: ${e.message}`);
  }
};
setTimeout(runBackup, 60_000).unref();
setInterval(runBackup, 3600_000).unref();
// Study reward events for Hey Ann (outbox only; nothing is sent until a transport exists).
const runRewards = () => {
  try {
    app.rewards.tick();
  } catch (e: any) {
    console.error(`[socrates] Reward computation failed: ${e.message}`);
  }
};
setTimeout(runRewards, 90_000).unref();
setInterval(runRewards, 5 * 60_000).unref();
// Embed any questions that don't have a vector yet (first run, offline adds, edits).
setTimeout(() => app.backfillEmbeddings(), 1500).unref();

const servers = [
  serve({ fetch: ui.fetch, port: cfg.port, hostname: cfg.host }, () => {
    console.log(`Socrates  ${cfg.publicOrigin ?? `http://localhost:${cfg.port}`}  (listening on ${cfg.host}:${cfg.port})`);
    if (owner) console.log('Login     password + authenticator code');
    if (!cfg.deployed && !cfg.oauth) console.log(`MCP HTTP  http://localhost:${cfg.port}/mcp  (bearer token: Settings > Connect)`);
  }),
];
if (mcp && cfg.mcpPort) {
  servers.push(serve({ fetch: mcp.fetch, port: cfg.mcpPort, hostname: cfg.host }, () => {
    console.log(`MCP       ${cfg.oauth!.resource}  (Orbit Identity OAuth; listening on ${cfg.host}:${cfg.mcpPort})`);
  }));
}

// Kubernetes stops the pod with SIGTERM: stop accepting requests, then close SQLite cleanly.
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  let open = servers.length;
  const done = () => {
    try { app.db.close(); } catch {}
    process.exit(0);
  };
  for (const s of servers) s.close(() => { if (--open === 0) done(); });
  setTimeout(done, 8000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
