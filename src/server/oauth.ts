// OAuth resource server for /mcp: verifies Orbit Identity access tokens (RFC 9068, ES256) against a JWKS file.
// The pod has no network egress, so the key set is mounted from a ConfigMap rather than fetched. Mirrors Sprawl
// MCP's checks (src/Sprawl.Mcp/Program.cs AddJwtBearer + Security.cs SubjectAccessPolicy).
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import { readBounded } from './owner.ts';
import type { OAuthConfig } from './config.ts';
import { SCOPES } from '../mcp/server.ts';

export const SCOPES_SUPPORTED = [SCOPES.read, SCOPES.write];
/** What a 401 asks for: everyday use. */
export const CHALLENGE_SCOPE = SCOPES_SUPPORTED.join(' ');

export function loadJwks(file: string): JSONWebKeySet {
  let jwks: JSONWebKeySet;
  try {
    jwks = JSON.parse(readBounded(file, 2, 64 * 1024, 'The OAuth JWKS file is missing or invalid.'));
  } catch (e: any) {
    throw new Error(`The OAuth JWKS file is not valid JSON: ${e.message}`);
  }
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  if (!keys.some((k) => k.kty === 'EC' && k.crv === 'P-256' && (k.use === undefined || k.use === 'sig') && !('d' in k)))
    throw new Error('The OAuth JWKS file has no ES256 (EC P-256) signing key.');
  if (keys.some((k) => 'd' in k)) throw new Error('The OAuth JWKS file contains a private key. Mount the public key set only.');
  return jwks;
}

export type TokenCheck =
  | { ok: true; sub: string; scopes: Set<string>; client: string | null; via: string | null }
  | { ok: false; reason: string };

export function tokenVerifier(cfg: OAuthConfig, jwks: JSONWebKeySet = loadJwks(cfg.jwksFile)) {
  const keySet = createLocalJWKSet(jwks);
  return async (token: string | undefined): Promise<TokenCheck> => {
    if (!token) return { ok: false, reason: 'missing token' };
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keySet, {
        issuer: cfg.issuer,
        audience: cfg.resource,
        algorithms: ['ES256'],
        typ: 'at+jwt',
        clockTolerance: 60,
        requiredClaims: ['exp', 'iat', 'sub'],
      }));
    } catch (e: any) {
      return { ok: false, reason: e.code ?? 'invalid token' };
    }
    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    if (!sub || /@clients$/i.test(sub)) return { ok: false, reason: 'not a user token' };
    const grant = payload.gty ?? payload.grant_type;
    if (grant === 'client-credentials' || grant === 'client_credentials') return { ok: false, reason: 'client credentials grant' };
    if (!cfg.allowedSubjects.includes(sub)) return { ok: false, reason: 'subject not allowed' };
    const client = typeof payload.client_id === 'string' ? payload.client_id : typeof payload.azp === 'string' ? payload.azp : null;
    if (cfg.allowedClients.length && (!client || !cfg.allowedClients.includes(client))) return { ok: false, reason: 'client not allowed' };
    const raw = [payload.scope, payload.scp].flatMap((v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(' ') : []));
    // RFC 8693 delegation: Orbit Hub exchanges its token for one aimed at this resource and names itself in `act`.
    const act = payload.act as { sub?: unknown } | undefined;
    const via = act && typeof act.sub === 'string' && act.sub ? act.sub : null;
    return { ok: true, sub, scopes: new Set(raw.map(String).map((s) => s.trim()).filter(Boolean)), client, via };
  };
}

/** RFC 9728 protected-resource metadata: exactly one authorization server, and `resource` equal to the URL users enter. */
export const resourceMetadata = (cfg: OAuthConfig) => ({
  resource: cfg.resource,
  authorization_servers: [cfg.issuer],
  scopes_supported: SCOPES_SUPPORTED,
  bearer_methods_supported: ['header'],
  resource_name: 'Socrates',
});

export const challenge = (mcpOrigin: string) =>
  `Bearer resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource", scope="${CHALLENGE_SCOPE}"`;
