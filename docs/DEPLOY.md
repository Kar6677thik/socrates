# Deploying Socrates on Megatron

Socrates runs in k3s on Megatron as a hand-reviewed namespace, set up the same way as Sprawl.

| | Address | Who can reach it | Auth |
|---|---|---|---|
| UI + API | `https://socrates.tailf67d61.ts.net` | your devices on the tailnet (`tailscale serve`, tailnet policy grant) | password + authenticator code |
| MCP | `https://socrates-mcp.karthiksurkanti.in/mcp` | the internet, through the Cloudflare tunnel, **only** `/mcp` and `/.well-known/oauth-protected-resource[/mcp]` | Orbit Identity OAuth, owner only |

The two are separate listeners in one process (`:8080` and `:8081`). The MCP listener answers 404 to everything except those paths, so even a wrong tunnel rule can't expose the UI.

## Security model

- **Pod:** Pod Security `restricted`, read-only root filesystem, no capabilities, non-root `1654`, no service-account token, default-deny NetworkPolicy, **no egress at all**. The embedding model is inside the image and Identity's public keys are a mounted ConfigMap, so the pod never needs the network.
- **UI listener:** exact Host allow-list; HTTPS required, seen through `X-Forwarded-Proto` only from the node (`10.42.0.1`); owner session cookie (`__Host-`, HttpOnly, Secure, SameSite=Strict, 30 min idle, 12 h max, in memory so a restart signs you out); login throttled to 5 failures per 15 min, TOTP codes single-use. Writes need a JSON body (forces a CORS preflight), a matching `Origin` and no cross-site fetch metadata.
- **MCP listener:** RFC 9068 access tokens (`typ: at+jwt`), ES256 only, exact issuer and audience, `exp` required, 60 s skew, owner `sub` only, no client-credentials tokens. Scopes: `socrates.read` for the read tools, `socrates.write` for every tool that changes something; tools outside the token's scopes are not even listed. Browser `Origin` must be `https://claude.ai` (or absent). 1 MiB body limit, 90 requests per minute.
- **Code runner:** submitted JavaScript runs in a separate Node process with the permission model on and nothing granted (no files, child processes or workers), an empty environment, a 64 MB heap and a 5 s kill. Node before v25 doesn't restrict network access through the permission model; the pod's empty egress policy covers that.

## What you need

- A PC with Docker, for building the image.
- SSH to Megatron with `sudo`; `kubectl` there.
- Access to the Tailscale admin console (policy file).
- A restic backend (Backblaze B2 or S3) for off-node backups.

## 1. Build and import the image

On the PC, in the repository:

```bash
docker build --platform linux/amd64 -t ghcr.io/kar6677thik/socrates:candidate .
docker save ghcr.io/kar6677thik/socrates:candidate -o socrates.tar
scp socrates.tar deploy/import-image.sh megatron:/tmp/
```

The build runs the typecheck and the full test suite and fails if they fail.

On Megatron:

```bash
sudo sh /tmp/import-image.sh ghcr.io/kar6677thik/socrates /tmp/socrates.tar   # prints the digest (hex)
rm /tmp/socrates.tar
```

No registry credentials are ever stored in the cluster. Pushing to private GHCR is optional, for provenance only.

## 2. Secrets and the key set

Owner login: use a password **separate from Orbit's and Sprawl's**. On the PC:

```bash
node --no-warnings scripts/credentials.ts ./.owner     # asks for the password; prints the authenticator secret
```

Add the printed `otpauth://` line (or the secret) to your authenticator app. `orbit-cloud`'s `Orbit.Credentials` writes the same formats if you prefer it. Copy the two files to Megatron and create the Secret, then delete the local copies:

```bash
kubectl create namespace socrates      # step 3's apply adds the Pod Security labels
kubectl -n socrates create secret generic socrates-owner --from-file=verifier=./.owner/verifier --from-file=totp=./.owner/totp
shred -u ./.owner/verifier ./.owner/totp
```

Orbit Identity's public keys:

```bash
curl -fsS https://auth.karthiksurkanti.in/.well-known/jwks -o jwks.json
kubectl -n socrates create configmap socrates-jwks --from-file=jwks.json
```

Socrates refuses to start if the file has no P-256 key or contains a private key.

## 3. Apply

```bash
kubectl get svc -A -o wide | grep '10.43.0.10'        # 10.43.0.105 must be free
sed "s/IMAGE_DIGEST/<digest from step 1>/" deploy/socrates.yaml > /tmp/socrates.yaml
kubectl apply --dry-run=server -f /tmp/socrates.yaml
kubectl apply -f /tmp/socrates.yaml
kubectl -n socrates rollout status deploy/socrates
```

## 4. Tailnet access (UI)

1. Tailscale admin console → Access controls, next to `svc:sprawl`, without touching anything else:
   - in `grants`: `{ "src": ["<your login>"], "dst": ["svc:socrates"], "ip": ["tcp:443"] }`
   - in `autoApprovers.services`: `"svc:socrates": ["tag:megatron"]`
2. On Megatron:
   ```bash
   sudo tailscale serve --service=svc:socrates --https=443 http://10.43.0.105:8080
   tailscale funnel status        # socrates must NOT be listed
   ```
3. Open `https://socrates.tailf67d61.ts.net` and sign in.

Never use `tailscale funnel` for Socrates.

## 5. Public MCP (Orbit Identity)

Done in the Orbit Cloud thread, with your OK, in this order:

1. **Identity resource** (`deploy/identity/identity.yaml` in orbit-cloud), then release Identity:
   ```yaml
   - { name: Identity__Resources__2__Uri, value: "https://socrates-mcp.karthiksurkanti.in/mcp" }
   - { name: Identity__Resources__2__Name, value: "Socrates" }
   - { name: Identity__Resources__2__Scopes__0, value: socrates.read }
   - { name: Identity__Resources__2__Scopes__1, value: socrates.write }
   ```
   No `socrates.admin`: no Socrates tool hard-deletes anything (archiving is a status change), and most agent changes can be reverted from Agent activity.
2. **Tunnel route** in Megatron's `~/.cloudflared/config.yml`, above the catch-all:
   ```yaml
   - hostname: socrates-mcp.karthiksurkanti.in
     path: ^/(mcp|\.well-known/oauth-protected-resource(/mcp)?)$
     service: http://10.43.0.105:8081
   - hostname: socrates-mcp.karthiksurkanti.in
     service: http_status:404
   ```
   then `cloudflared tunnel route dns main socrates-mcp.karthiksurkanti.in` and restart `cloudflared-main-slate-web.service`. Also add the `deploy/routes.json` entry and the uptime probe on the protected-resource URL.
3. **Connect:** in Claude, Settings → Connectors → Add custom connector → `https://socrates-mcp.karthiksurkanti.in/mcp`. Sign in and consent on `auth.tailf67d61.ts.net` from a tailnet device. Check that the consent screen offers only `socrates.*`, and that revoking in Orbit → Identity cuts access.

## 6. Backups

The app writes a verified copy (`VACUUM INTO` + `PRAGMA integrity_check`) to `/data/backups` once a day, shortly after 00:00 UTC, keeps 14, and records the result in `backup-status.json`. Settings → Data → *Back up now* makes one on demand.

Off-node: create the restic Secret, then apply the CronJob (02:30 UTC daily):

```bash
kubectl -n socrates create secret generic socrates-backup \
  --from-literal=RESTIC_REPOSITORY='s3:https://<endpoint>/<bucket>/socrates' \
  --from-literal=RESTIC_PASSWORD='<long random; keep it in your password manager>' \
  --from-literal=AWS_ACCESS_KEY_ID='…' --from-literal=AWS_SECRET_ACCESS_KEY='…'
kubectl apply -f deploy/backup.yaml
kubectl -n socrates create job --from=cronjob/socrates-backup socrates-backup-first
kubectl -n socrates logs -f job/socrates-backup-first
```

It ships `/data/backups` and `/data/media` (not the model). Orbit's *Jobs & backups* page tracks it through the `app.kubernetes.io/component: backup` label.

### Restore

Test this once before relying on it. Steps are at the top of `deploy/restore.yaml`: scale to zero, run the job, scale back. The current database is moved to `/data/pre-restore/`, never deleted.

## 7. Checks after install

- From your laptop: the UI without a session shows the sign-in screen; `curl https://socrates.tailf67d61.ts.net/api/home` returns 401.
- A different Host is refused: `curl -k -H 'Host: x' https://socrates.tailf67d61.ts.net/api/home` → 403.
- `kubectl auth can-i --list --as=system:serviceaccount:socrates:socrates -n socrates` shows nothing beyond the defaults.
- No egress from the pod: `kubectl -n socrates exec deploy/socrates -- node -e "fetch('https://example.com').then(()=>console.log('OPEN'),()=>console.log('blocked'))"` prints `blocked`.
- After step 5: `curl -s https://socrates-mcp.karthiksurkanti.in/.well-known/oauth-protected-resource` shows the metadata, `curl -si https://socrates-mcp.karthiksurkanti.in/mcp` returns 401 with `WWW-Authenticate`, and `https://socrates-mcp.karthiksurkanti.in/` returns 404.

## Updating

Build, import and apply with the new digest (steps 1 and 3). `Recreate` stops the old pod before the new one opens the database; schema upgrades take a backup first.

## Rotating Identity's signing key

1. Add the new key to Identity as a secondary key (it's published, but doesn't sign yet).
2. Refresh the ConfigMap and restart Socrates:
   ```bash
   curl -fsS https://auth.karthiksurkanti.in/.well-known/jwks -o jwks.json
   kubectl -n socrates create configmap socrates-jwks --from-file=jwks.json --dry-run=client -o yaml | kubectl apply -f -
   kubectl -n socrates rollout restart deploy/socrates
   ```
3. Only then make the new key the signer in Identity.

## Environment reference

| Variable | Meaning |
|---|---|
| `SOCRATES_PUBLIC_ORIGIN` | UI origin. Turns on deployed mode: login required, HTTPS required, no local-token MCP. |
| `SOCRATES_ALLOWED_HOSTS` | Extra exact Host values for the UI (comma-separated). localhost is always allowed (probes). |
| `SOCRATES_TRUSTED_PROXY` | Addresses whose `X-Forwarded-Proto` is believed. |
| `SOCRATES_CREDENTIAL_FILE`, `SOCRATES_TOTP_FILE` | Owner login files. |
| `SOCRATES_MCP_PORT`, `SOCRATES_MCP_PUBLIC_ORIGIN`, `SOCRATES_MCP_ALLOWED_ORIGINS` | The OAuth MCP listener. |
| `SOCRATES_OAUTH_ISSUER`, `SOCRATES_OAUTH_RESOURCE`, `SOCRATES_OAUTH_ALLOWED_SUBJECTS`, `SOCRATES_OAUTH_JWKS_FILE` | Token checks. `SOCRATES_OAUTH_ALLOWED_CLIENTS` optionally limits client ids. |
| `SOCRATES_DATA`, `SOCRATES_MODELS`, `SOCRATES_MODELS_OFFLINE` | Data directory; model directory; `1` = never download the model. |
| `SOCRATES_URL` | Base URL for links in MCP results. |

Startup refuses incomplete or unsafe combinations (for example a deployed origin without the login files, a non-https origin, or OAuth without the owner subject).
