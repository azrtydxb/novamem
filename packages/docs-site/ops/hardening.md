---
title: Hardening checklist
---

# Hardening checklist

Production checklist for self-hosted novamem. Walk this top-to-bottom before exposing the service publicly.

## Secrets

- [ ] `NOVAMEM_COOKIE_SECRET` is `openssl rand -hex 32`. Never the placeholder. Rotating invalidates every session.
- [ ] `POSTGRES_PASSWORD` is `openssl rand -base64 24`. Stored via Kubernetes Secret / `.env` (mode 0600) — never in git.
- [ ] `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` is set ONLY for first boot. Comment it out / unset after the first user is created.
- [ ] No user API tokens (`nm_…`) committed to repos / shared via plaintext channels.

## Network

- [ ] Reverse proxy (nginx / Traefik / cloudflared) terminating TLS in front of novamem. The server itself doesn't do TLS.
- [ ] `NOVAMEM_INSECURE_COOKIES=0` (default). Anything else drops `Secure` flag — only safe behind a guaranteed-TLS proxy on localhost.
- [ ] `NOVAMEM_CORS_ORIGINS` is a tight allowlist if you're running browser-based SDK clients on different origins. `*` is accepted but disables credentialed CORS — sessions from a browser need explicit origins.
- [ ] `NOVAMEM_HOST=127.0.0.1` if your reverse proxy is on the same host — avoids accidental direct exposure.

## Auth

- [ ] `NOVAMEM_AUTH_MODE` is `user` or `bearer`, never `none` in production.
- [ ] Bootstrap admin password changed via the dashboard's account page after first sign-in.
- [ ] Use one user API token per service / agent host so metrics and revocation are precise.
- [ ] Token rotation policy: revoke + remint quarterly, or whenever a host is decommissioned / employee leaves.

## Datastores

- [ ] Postgres backups enabled (pg_dump nightly + WAL archive for PITR if you need it). Test the restore.
- [ ] Postgres `max_connections` ≥ `NOVAMEM_PG_POOL_MAX` × replica count + headroom.
- [ ] Qdrant collections backed up (snapshots), or accept that they're rebuildable from warm-tier embeddings.
- [ ] FalkorDB persistence enabled (Redis AOF / RDB) — graph state is recoverable from warm via reindex but downtime is unpleasant.

## Dashboard

- [ ] If you don't need the dashboard: `NOVAMEM_ADMIN_DASHBOARD=0` — `/admin/*` and `/v1/admin/metrics` 404.
- [ ] If you do need it: behind a separate auth layer (mTLS / VPN / SSO proxy) when possible. Better Auth + cookies is good but defense-in-depth.

## Observability

- [ ] Pino log level set appropriately (`info` for prod, `debug` for staging).
- [ ] Logs shipped somewhere durable (Loki / Cloudwatch / Datadog) — not just stdout in a pod.
- [ ] OTLP enabled (`OTEL_EXPORTER_OTLP_ENDPOINT`) and traces routed to your existing collector.
- [ ] `/health` polled by your load balancer + monitoring (alert when degraded).

## Audit

- [ ] [`admin_audit_log`](/ops/audit-log) reviewed periodically — NovaMem-owned admin actions are recorded; corroborate Better Auth plugin actions with auth/session logs.
- [ ] User table reviewed quarterly — disable accounts of departed teammates.

## Headers

novamem sets these by default; verify none are stripped by your reverse proxy:

- `Strict-Transport-Security: max-age=31536000; includeSubDomains` (when behind TLS)
- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: same-origin`

## Rate limiting

`NOVAMEM_RATE_LIMIT_PER_MINUTE = 600` is per-IP. Tune for your traffic — too low blocks legitimate agents, too high doesn't protect against floods. SSE bypasses the limit (one long-lived connection); see `MAX_SESSIONS_PER_USER` for SSE caps.

## Pin the docker image

Don't run `:main` in production. Pin to a release tag (`v1.1.4`) or short sha (`:sha-d8e602f`). The release notes on GitHub describe what each tag includes.

## Threat model snapshot

| Threat | Mitigation |
|---|---|
| Bearer token leaked | Revoke from dashboard. Short labels per host help isolate the blast radius. |
| Cross-user data access | User boundary enforced at every route. Project membership is explicit. |
| | Cookie session theft | Sessions are HttpOnly + Secure. Rotate `NOVAMEM_COOKIE_SECRET` to mass-invalidate. |
| Replay attacks | Better Auth sessions are server-resolved per request — no JWT replay window. |
| Prompt injection via memory entries | Memory content is opaque to novamem. Defence is upstream (in your agent). |
