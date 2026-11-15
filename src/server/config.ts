// Runtime configuration from environment variables, checked once at startup.
//
// Local (default): one listener on 127.0.0.1:4321, no login, localhost Host headers only, and /mcp with the
// local bearer token from Settings.
//
// Deployed (SOCRATES_PUBLIC_ORIGIN set): the UI listener also accepts that origin's host, requires HTTPS from a
// trusted proxy, and requires the owner login (password + TOTP). The local-token /mcp is gone; MCP is served only
// on its own listener (SOCRATES_MCP_PORT) with Orbit Identity OAuth, once that is configured.

export interface OAuthConfig {
  issuer: string;
  /** The MCP URL clients enter; also the required token audience. */
  resource: string;
  allowedSubjects: string[];
  /** Optional allow-list of OAuth client ids (client_id / azp). Empty: any client Identity approved. */
  allowedClients: string[];
  jwksFile: string;
}

export interface Config {
  port: number;
  host: string;
  deployed: boolean;
  /** Origin of the UI, e.g. https://socrates.example.ts.net. Null locally. */
  publicOrigin: string | null;
  /** Exact Host header values the UI listener accepts (localhost variants are always accepted). */
  allowedHosts: string[];
  trustedProxies: string[];
  credentialFile: string | null;
  totpFile: string | null;
  /** Separate MCP listener port (deployed: required for MCP). Null: MCP on the UI listener with the local token. */
  mcpPort: number | null;
  mcpPublicOrigin: string | null;
  /** Browser origins allowed to call /mcp (requests without Origin are always allowed). */
  mcpAllowedOrigins: string[];
  oauth: OAuthConfig | null;
}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function httpsOrigin(value: string, name: string): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (u.protocol !== 'https:') throw new Error(`${name} must use https`);
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error(`${name} must be a bare origin like https://host`);
  return u.origin;
}

function port(value: string | undefined, name: string, fallback: number | null): number | null {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name} must be a port number`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicOrigin = env.SOCRATES_PUBLIC_ORIGIN ? httpsOrigin(env.SOCRATES_PUBLIC_ORIGIN, 'SOCRATES_PUBLIC_ORIGIN') : null;
  const deployed = publicOrigin !== null;
  const allowedHosts = [...new Set([...(publicOrigin ? [new URL(publicOrigin).host] : []), ...list(env.SOCRATES_ALLOWED_HOSTS)])];
  for (const h of allowedHosts) if (!/^[a-z0-9.-]+(:\d+)?$/i.test(h) || h.includes('*')) throw new Error(`SOCRATES_ALLOWED_HOSTS: "${h}" is not an exact host name`);

  const credentialFile = env.SOCRATES_CREDENTIAL_FILE || null;
  const totpFile = env.SOCRATES_TOTP_FILE || null;
  if (deployed && (!credentialFile || !totpFile))
    throw new Error('A deployed Socrates needs the owner login: set SOCRATES_CREDENTIAL_FILE and SOCRATES_TOTP_FILE.');
  if (totpFile && !credentialFile) throw new Error('SOCRATES_TOTP_FILE needs SOCRATES_CREDENTIAL_FILE.');

  const mcpPort = port(env.SOCRATES_MCP_PORT, 'SOCRATES_MCP_PORT', null);
  const uiPort = port(env.PORT, 'PORT', 4321)!;
  if (mcpPort !== null && mcpPort === uiPort) throw new Error('SOCRATES_MCP_PORT must differ from PORT.');

  let oauth: OAuthConfig | null = null;
  if (env.SOCRATES_OAUTH_ISSUER) {
    const issuer = env.SOCRATES_OAUTH_ISSUER;
    if (!/^https:\/\/[^/?#]+\/$/.test(issuer)) throw new Error('SOCRATES_OAUTH_ISSUER must be the exact https issuer, ending in "/"');
    const resource = env.SOCRATES_OAUTH_RESOURCE ?? '';
    const r = (() => { try { return new URL(resource); } catch { return null; } })();
    if (!r || r.protocol !== 'https:' || r.pathname !== '/mcp' || r.search || r.hash) throw new Error('SOCRATES_OAUTH_RESOURCE must be the https URL of /mcp');
    const allowedSubjects = list(env.SOCRATES_OAUTH_ALLOWED_SUBJECTS);
    if (allowedSubjects.length === 0) throw new Error('SOCRATES_OAUTH_ALLOWED_SUBJECTS must name the owner subject.');
    if (!env.SOCRATES_OAUTH_JWKS_FILE) throw new Error('SOCRATES_OAUTH_JWKS_FILE is required with SOCRATES_OAUTH_ISSUER.');
    if (mcpPort === null) throw new Error('OAuth MCP runs on its own listener: set SOCRATES_MCP_PORT.');
    oauth = { issuer, resource: r.href, allowedSubjects, allowedClients: list(env.SOCRATES_OAUTH_ALLOWED_CLIENTS), jwksFile: env.SOCRATES_OAUTH_JWKS_FILE };
  }

  const mcpPublicOrigin = env.SOCRATES_MCP_PUBLIC_ORIGIN ? httpsOrigin(env.SOCRATES_MCP_PUBLIC_ORIGIN, 'SOCRATES_MCP_PUBLIC_ORIGIN') : null;
  if (oauth && !mcpPublicOrigin) throw new Error('SOCRATES_MCP_PUBLIC_ORIGIN is required with SOCRATES_OAUTH_ISSUER.');
  if (oauth && new URL(oauth.resource).origin !== mcpPublicOrigin) throw new Error('SOCRATES_OAUTH_RESOURCE must be on SOCRATES_MCP_PUBLIC_ORIGIN.');
  if (mcpPort !== null && !oauth) throw new Error('SOCRATES_MCP_PORT is only for OAuth MCP: also set SOCRATES_OAUTH_ISSUER and the other SOCRATES_OAUTH_* settings.');
  const mcpAllowedOrigins = list(env.SOCRATES_MCP_ALLOWED_ORIGINS).map((o) => httpsOrigin(o, 'SOCRATES_MCP_ALLOWED_ORIGINS'));

  const trustedProxies = list(env.SOCRATES_TRUSTED_PROXY);
  for (const p of trustedProxies) if (!/^[0-9a-f.:]+$/i.test(p)) throw new Error(`SOCRATES_TRUSTED_PROXY: "${p}" is not an IP address`);
  if ((deployed || oauth) && trustedProxies.length === 0)
    throw new Error('Set SOCRATES_TRUSTED_PROXY to the address of the HTTPS proxy (tailscale serve / cloudflared).');

  return {
    port: uiPort,
    host: env.HOST ?? '127.0.0.1',
    deployed,
    publicOrigin,
    allowedHosts,
    trustedProxies,
    credentialFile,
    totpFile,
    mcpPort,
    mcpPublicOrigin,
    mcpAllowedOrigins,
    oauth,
  };
}
