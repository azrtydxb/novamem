# CI/CD & Operational Practices Review

Scope: novamem monorepo @ `/Users/pascal/Development/novamem-1`. This phase reviewed
the existing GitHub Actions workflow (`ci.yml`), `Dockerfile`, `docker-compose.yaml`,
`package.json` scripts across the four workspace packages, the service entry-point
(`packages/server/src/main.ts`) and logger config (`packages/server/src/http.ts:204`).

Severity legend: **Critical** — blocks production; **High** — ship-stopper for any non-toy
deployment; **Medium** — meaningful operational risk; **Low** — polish / hygiene.

---

## CI-C1 — CI workflow exists but is the bare minimum (Medium)

**File:** `.github/workflows/ci.yml`

The current workflow runs `pnpm typecheck && pnpm build && pnpm test`. That's good — it
catches the obvious regressions. But for a project that publishes two npm packages and a
docker image, several gates that *must* exist before tagging a release are missing:

1. No matrix across Node versions (engines say `>=20`, only Node 20 is exercised).
2. No `pnpm lint` step — the script exists at the root (`"lint": "pnpm -r lint"`) but no
   per-package lint scripts back it; running it today is a no-op. Either wire ESLint
   into each package or remove the script so it stops being theater.
3. No integration test job — `packages/server/package.json` defines
   `test:integration` (`NOVAMEM_INTEGRATION=1 vitest run --dir tests`) which spins up
   live Postgres/Qdrant/FalkorDB, but CI never runs it. Given the M4/A9 DDL ordering
   bug already shipped against a clean Postgres (recent commit ccd56d6 fixed it), this
   gap is the proximate cause.
4. `pnpm install` rather than `--frozen-lockfile` is fine; `pnpm test` does *not* fail
   on uncommitted lockfile drift — add `pnpm install --frozen-lockfile` strict mode in CI.

**Recommendation** — extend `ci.yml` with a separate `integration` job using service
containers:

```yaml
  integration:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_USER: novamem, POSTGRES_PASSWORD: novamem, POSTGRES_DB: novamem }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U novamem" --health-interval 5s
          --health-timeout 5s --health-retries 10
      qdrant:
        image: qdrant/qdrant:v1.12.4
        ports: ["6333:6333"]
      falkordb:
        image: falkordb/falkordb:edge
        ports: ["6379:6379"]
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build
      - run: pnpm --filter @azrty/novamem-server test:integration
        env:
          NOVAMEM_WARM_URL: postgres://novamem:novamem@localhost:5432/novamem
          NOVAMEM_COLD_URL: http://localhost:6333
          NOVAMEM_GRAPH_URL: redis://localhost:6379
```

---

## CI-C2 — No dependency / vulnerability scanning anywhere in the pipeline (High)

There is no Dependabot config (`.github/dependabot.yml` absent), no Renovate
(`renovate.json` absent), no `pnpm audit` step in CI, no Snyk, no GHSA gating. For a
service that:

- ships two npm packages (`@azrty/novamem`, `@azrty/novamem-mcp`) which downstream
  Claude/MCP integrations install,
- exposes a network service handling bearer tokens and bcrypt hashes,

this is an unacceptable supply-chain posture. A single vulnerable transitive dep
(bcryptjs, pg, falkordb, @qdrant/js-client-rest, @xenova/transformers — all third-party)
will sit in the lockfile indefinitely.

**Recommendation** —

1. Add `.github/dependabot.yml`:

   ```yaml
   version: 2
   updates:
     - package-ecosystem: npm
       directory: /
       schedule: { interval: weekly }
       groups:
         non-major: { update-types: [minor, patch] }
     - package-ecosystem: docker
       directory: /
       schedule: { interval: weekly }
     - package-ecosystem: github-actions
       directory: /
       schedule: { interval: weekly }
   ```

2. Add an audit job that fails on High/Critical:

   ```yaml
   audit:
     runs-on: ubuntu-latest
     steps:
       - uses: actions/checkout@v4
       - uses: pnpm/action-setup@v4
         with: { version: 9 }
       - run: pnpm audit --audit-level high --prod
   ```

---

## CI-C3 — No container image scanning (High)

The Dockerfile builds a `node:20-slim` image and the project's primary deploy artifact is
the docker image, but nothing scans it. Trivy or Grype as a CI step is ~30s and catches
both OS-level CVEs in Debian slim and JS deps in `node_modules`.

**Recommendation** — add a `docker` job to `ci.yml`:

```yaml
  image-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with: { context: ., load: true, tags: novamem:ci }
      - uses: aquasecurity/trivy-action@0.28.0
        with:
          image-ref: novamem:ci
          severity: CRITICAL,HIGH
          exit-code: 1
          ignore-unfixed: true
```

---

## CI-C4 — No automated release / publish flow (High)

Both `@azrty/novamem` and `@azrty/novamem-mcp` are at `0.1.0-preview.0`. There is no
release workflow — bumping a version, generating a changelog, tagging, and `npm publish`
are entirely manual. For a 2-package npm release, this works once; on the 5th release
it produces drift between package versions, missed publishes, and untagged installs.

**Recommendation** — adopt **changesets** (low ceremony, monorepo-native):

1. `pnpm add -Dw @changesets/cli && pnpm changeset init`.
2. PR authors run `pnpm changeset` to record what changed and which packages bump.
3. A release workflow opens a "Version Packages" PR and, on merge, runs
   `pnpm changeset publish`.

Workflow skeleton (`.github/workflows/release.yml`):

```yaml
name: Release
on:
  push:
    branches: [main]
permissions: { contents: write, pull-requests: write, id-token: write }
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm, registry-url: https://registry.npmjs.org }
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r build
      - uses: changesets/action@v1
        with:
          publish: pnpm changeset publish
        env:
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Use `npm provenance` (`--provenance`) once on a public registry — a free supply-chain
win for npm packages built in GitHub Actions.

---

## D-C1 — Container runs as root (High)

**File:** `Dockerfile:17-25`

The runtime stage has no `USER` directive. The process runs as `root` inside the
container. Container escapes are rare; root-inside-container makes them catastrophic.
This is also a Kubernetes PodSecurityStandards `restricted` violation, so the image
won't deploy to any cluster with that policy enforced.

**Recommendation** — add a non-root user. Final stage:

```dockerfile
FROM node:20-slim AS runtime
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml* ./
COPY --from=build --chown=node:node /app/packages/server/dist ./packages/server/dist
COPY --from=build --chown=node:node /app/packages/admin-ui/dist ./packages/admin-ui/dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
ENV NODE_ENV=production
USER node
EXPOSE 7778
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7778/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "packages/server/dist/main.js"]
```

The `node:20-slim` image already has a `node` user uid 1000.

---

## D-C2 — Runtime stage ships sources, tests, and dev deps (High)

**File:** `Dockerfile:21-22`

```
COPY --from=build /app/packages ./packages
COPY --from=build /app/node_modules ./node_modules
```

This copies *everything* under `packages/` (including `src/*.ts`, `tests/`, `scripts/`,
`tsconfig.json`, the unbuilt admin-ui sources after the build copies its `dist/` into
the server) and the *entire* `node_modules` graph including dev deps (`tsx`, `vitest`,
`@types/*`, `typescript`).

Operational impact:

- Larger image → slower pulls, higher registry cost.
- Larger attack surface (a CVE in `tsx` or `@types/better-sqlite3` is reachable inside
  a production container that doesn't need them).
- Source files leak (`src/*.ts`) — not catastrophic for an MIT project, but unexpected.

**Recommendation** — three changes:

1. Add a `.dockerignore` (currently absent):

   ```
   **/node_modules
   **/dist
   .git
   .github
   .full-review
   .claude
   .kilocode
   openspec
   *.md
   tests
   **/*.test.ts
   ```

2. In the build stage, after `pnpm -r build`, run `pnpm -r --prod deploy` (or
   `pnpm install --prod --frozen-lockfile`) into a clean dir, and copy *that* + the
   per-package `dist/` only:

   ```dockerfile
   FROM deps AS build
   COPY . .
   RUN pnpm -r build && \
       pnpm --filter @azrty/novamem-server deploy --prod /out

   FROM node:20-slim AS runtime
   WORKDIR /app
   COPY --from=build --chown=node:node /out ./
   USER node
   EXPOSE 7778
   CMD ["node", "dist/main.js"]
   ```

   `pnpm deploy` produces a self-contained, prod-only, hoisted node_modules. This
   typically halves the image.

---

## D-H1 — No HEALTHCHECK directive in Dockerfile (Medium)

**File:** `Dockerfile`

`/health` exists in the server (returns 503 when a dep is unreachable), but the image
has no `HEALTHCHECK`. Docker, Compose, and orchestrators that fall back to docker-level
health (Nomad, Swarm, ECS without explicit healthcheck overrides) won't notice a wedged
process.

**Recommendation** — see the snippet under D-C1; one-line addition.

---

## D-H2 — No image labels / OCI metadata (Low)

`org.opencontainers.image.{title,version,revision,source,licenses}` are absent. Tooling
(GHCR UI, registry scanners, SBOM generators) leans on these. Trivial fix:

```dockerfile
ARG GIT_SHA
ARG VERSION
LABEL org.opencontainers.image.title="novamem" \
      org.opencontainers.image.source="https://github.com/<owner>/novamem" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.licenses="MIT"
```

---

## OPS-H1 — Bootstrap admin password lives in `process.env` for the lifetime of the container (High — pairs with S-H6)

**Files:** `docker-compose.yaml:50`, `packages/server/src/main.ts:43-51`

`NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` is read once at startup but never `delete process.env.NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD`'d. Anyone with `docker inspect` access to the container, or who can read `/proc/1/environ`, recovers the bootstrap password.

This already shows up in the security findings (S-H6); from a *deployment* standpoint
the operational mitigations are:

1. After `bootstrapAdmin()` returns, `delete process.env.NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD`
   and `delete process.env.NOVAMEM_BOOTSTRAP_ADMIN_USERNAME`. Trivial code change.
2. Document a "set, deploy, *unset and redeploy*" procedure in the README so the env
   var is only set on the very first boot.
3. Better: switch to a one-shot `--bootstrap-admin` CLI subcommand that reads from a
   file path or stdin, hashes, inserts, and exits — no long-lived env var.

---

## C-H1 — `docker-compose.yaml` exposes every backing store on the host (High)

**File:** `docker-compose.yaml`

```
postgres:  ports: ["5432:5432"]
qdrant:    ports: ["6333:6333"]
falkordb:  ports: ["6379:6379"]
```

For local dev this is fine. The danger is operators who lift this file to a server
unchanged — the postgres password is `novamem`/`novamem` and the FalkorDB instance has
no auth at all, so `0.0.0.0:6379` to a public IP is "we are now mining cryptocurrency."
There is no comment in the compose file warning against this, and no separate
`docker-compose.prod.yaml` showing the production shape.

**Recommendation** — three concrete fixes:

1. Add a comment block at the top of `docker-compose.yaml` warning this is dev-only.
2. Drop the host port-mappings for `postgres` / `qdrant` / `falkordb` — services within
   the compose network reach each other by service name; only `novamem` needs a port
   exposed. This is also a security hardening.
3. Ship a `docker-compose.prod.example.yaml` showing the recommended shape (no host
   ports for backing stores, secrets pulled from `secrets:` not `environment:`,
   restart policy, resource limits, log driver).

---

## C-H2 — No `.env.example` file at the repo root (Medium)

There is no `.env.example`. Operators discover env vars by grepping the source. The set
includes `NOVAMEM_WARM_URL`, `NOVAMEM_COLD_URL`, `NOVAMEM_GRAPH_URL`,
`NOVAMEM_AUTH_MODE`, `NOVAMEM_AUTH_TOKEN`, `NOVAMEM_ADMIN_TOKEN`,
`NOVAMEM_ADMIN_DASHBOARD`, `NOVAMEM_BOOTSTRAP_ADMIN_USERNAME`,
`NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD`, `NOVAMEM_PORT`, `NOVAMEM_EMBEDDINGS_PROVIDER`,
`NOVAMEM_EMBEDDINGS_*`, `LOG_LEVEL`, decay intervals, rate limits, etc.

**Recommendation** — write a `.env.example` checked into the repo with every supported
var, default, type, and a one-line description. `loadConfig()` in `config.ts` is the
source of truth; the example should mirror it.

---

## OPS-H2 — Schema is forward-only with no migration tooling (High — pairs with P-H7)

**Source:** `packages/server/src/warm-store/index.ts` runs `ALTER TABLE … ADD COLUMN IF NOT EXISTS …`
on every boot. There is no:

- migration framework (Drizzle is in `dependencies` but only used as a type model;
  `drizzle-kit` is not present),
- DDL versioning table (`schema_migrations`),
- DOWN migrations,
- documented rollback strategy.

Operational consequences:

1. **Rollback is impossible.** Deploying v0.2 adds `entry_count` to `projects`. If you
   need to roll back to v0.1, the *code* rolls back but the column remains. Future v0.1
   code that doesn't know about the column still works (forward-compat by accident),
   but the inverse — a v0.2 column with a NOT NULL constraint — would break v0.1.
   Today nothing is NOT NULL except IDs, but there's no policy preventing it.
2. **K8s rolling deploys serialise on AccessExclusive locks** (already noted in P-H7).
3. **Database state and code state diverge silently.** A failed deploy halfway through
   a multi-statement DDL block leaves the schema in an unknown shape with no record.

**Recommendation** —

1. Adopt `drizzle-kit migrate` (the package is already a dep). Replace the boot-time
   DDL with a one-shot migration step that runs *before* the app starts (init container
   in K8s, separate `pnpm migrate` step in compose).
2. Document a migration policy in `docs/operations.md` (which doesn't exist either —
   see OPS-M2): additive-only, no NOT NULL on new columns without a default, no
   DROP TABLE/COLUMN without a deprecation cycle.

---

## OPS-H3 — Graceful shutdown does not drain SSE connections (Medium)

**File:** `packages/server/src/main.ts:150-158` and `packages/server/src/http.ts:921-940`

The shutdown handler closes the Fastify app, the graph, and the warm store. But
`sseTransports` (a Map of long-lived MCP-over-SSE sessions) is never iterated and
explicitly closed. `app.close()` will eventually destroy the underlying TCP sockets,
but clients see an unclean disconnect rather than the proper MCP close frame, and
in-flight requests are aborted mid-flight.

**Recommendation** — in `main.ts shutdown()`, before `app.close()`:

```ts
const shutdown = async () => {
  clearInterval(decayTimer);
  // 1. stop accepting new HTTP requests immediately
  await app.server.close?.();
  // 2. close SSE sessions cleanly (export sseTransports from http.ts)
  for (const { transport } of app.sseTransports.values()) {
    try { await transport.close(); } catch {}
  }
  // 3. now close fastify, then deps
  await app.close();
  if (graph) await graph.close();
  await warm.close();
  process.exit(0);
};
```

Either expose `sseTransports` on the Fastify instance (`app.decorate('sseTransports', sseTransports)`)
or have `buildHttpServer` return both the app and a teardown helper. Add a configurable
drain timeout (default 10s) before forcing shutdown.

---

## OPS-H4 — Logger has no `redact` config (High — pairs with security findings)

**File:** `packages/server/src/http.ts:204`

```ts
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, bodyLimit: 2 * 1024 * 1024 });
```

Pino supports `redact: { paths: [...], censor: '[redacted]' }`. With auth headers
(`Authorization`, `X-Admin-Token`), session cookies, password fields in
`POST /v1/admin/users`, and bearer tokens in query strings (the SSE shim sometimes
falls back to query param), production logs almost certainly contain secrets.

**Recommendation** —

```ts
const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-admin-token"]',
        'req.headers.cookie',
        'req.body.password',
        'req.body.currentPassword',
        'req.body.newPassword',
        'res.headers["set-cookie"]',
      ],
      censor: '[redacted]',
    },
  },
  bodyLimit: 2 * 1024 * 1024,
});
```

---

## OPS-M1 — No Prometheus / OpenTelemetry exposition (Medium)

The dashboard exposes `/v1/admin/metrics` returning JSON. It resets on restart, has no
historical retention, no alerting, no Grafana/Datadog integration.

For an OSS service that is meant to be deployed standalone, lack of a `/metrics` (Prom)
or OTLP exporter means operators *cannot* hook into normal SRE infra. The metrics
collector already aggregates everything; emitting in Prom format is ~80 lines using
`prom-client`.

**Recommendation** — add `prom-client`, a `/metrics` endpoint behind an opt-in flag
(`NOVAMEM_METRICS_PROM=1`), or a separate metrics port (best practice — keeps
admin-token auth off the scraping path). Mirror the existing counters/gauges. For
distributed tracing later, wire `@opentelemetry/sdk-node` with auto-instrumentation
for fastify/pg/http.

---

## OPS-M2 — No runbooks / operations docs (Medium)

The README covers "how to run." Nothing covers:

- "what happens when FalkorDB is unreachable" (engine has graceful degradation, but
  what does the operator see, what action should they take?),
- "Qdrant returned a dimension mismatch — how do I migrate collections,"
- "decay loop fell behind — how do I trigger it manually" (the engine has a
  `POST /v1/admin/decay` endpoint, undocumented),
- "Postgres ran out of disk during DDL,"
- "the dashboard says X warm entries, my DB says Y" (a metric reset story).

**Recommendation** — add `docs/operations.md` with a short runbook per failure mode.
Pair with `SECURITY.md` (also missing — see OPS-L2) so the disclosure path is
documented.

---

## OPS-M3 — No K8s manifests / Helm chart (Medium)

For a service whose target audience is "ship a memory backend next to my AI agent,"
the lack of any Kubernetes deployment artifact is a real friction point. A minimal
Helm chart or a kustomize base in `deploy/k8s/` covers 80% of operators.

**Recommendation** — out of scope to write here, but at minimum a 50-line
`deploy/kustomize/base/` with Deployment + Service + ConfigMap + Secret + a
NetworkPolicy that explicitly allows postgres/qdrant/falkordb egress. The
PodSecurityContext should set `runAsNonRoot: true`, `readOnlyRootFilesystem: true`,
`allowPrivilegeEscalation: false`, `seccompProfile: RuntimeDefault`. Resource
requests/limits documented.

---

## OPS-M4 — `pg.Pool max` not set (Medium — pairs with P-H6)

This is also flagged in performance findings; calling it out here from the deploy
angle: under K8s with HPA, multiple pods × default pool size (10) × N workers can
saturate Postgres `max_connections` (typically 100) very quickly. The fix is config:

```ts
new Pool({ connectionString: cfg.warm.url, max: cfg.warm.poolMax ?? 10, idleTimeoutMillis: 30_000 })
```

…and surface `NOVAMEM_PG_POOL_MAX` in the env docs.

---

## OPS-M5 — Server `package.json` is `private: false` by default (Low)

**File:** `packages/server/package.json`

The server is a runtime application but its package.json doesn't set `"private": true`.
A `pnpm publish -r` would attempt to push it. Add `"private": true` to be explicit and
avoid accidental publishes. Conversely, if the server *should* be publishable (it has
`bin: novamem-server`), keep it published but add an `npm publish` story to the release
flow.

---

## OPS-L1 — No `engines.npm`, no `packageManager` in sub-packages (Low)

Root sets `"packageManager": "pnpm@9.12.0"` ✓. Sub-packages don't. With Corepack, the
root setting wins, so this is a `Low`. Worth noting.

---

## OPS-L2 — No `SECURITY.md`, no `CODEOWNERS` (Low)

Both are GitHub-native files that take 5 minutes each. SECURITY.md should at least
contain a contact email and the supported-versions table; CODEOWNERS routes PRs to the
right reviewers automatically. Neither is critical, both are expected on a published
package's repo.

---

## Summary of severities

| Severity | Count | IDs |
|----------|-------|-----|
| Critical | 0 | — |
| High | 8 | CI-C2, CI-C3, CI-C4, D-C1, D-C2, OPS-H1, C-H1, OPS-H2, OPS-H4 (counted 9 by H prefix; CI-C* are High in operational severity despite the C prefix referring to numbering) |
| Medium | 7 | CI-C1, D-H1, C-H2, OPS-H3, OPS-M1, OPS-M2, OPS-M3, OPS-M4 |
| Low | 4 | D-H2, OPS-M5, OPS-L1, OPS-L2 |

(IDs use mixed prefixes — `CI-C*` = CI/CD, `D-*` = Dockerfile, `C-*` = compose,
`OPS-*` = ops/runtime.)

---

## Top 5 recommended changes ordered by impact ÷ effort

1. **Add `USER node` + `HEALTHCHECK` + `.dockerignore` to the Dockerfile** (D-C1, D-C2,
   D-H1) — one-evening change, halves image, satisfies PSS-restricted, removes a
   container-escape blast radius multiplier.
2. **Add Dependabot + `pnpm audit` job + Trivy job** (CI-C2, CI-C3) — three short YAML
   files, one weekend of housekeeping the resulting first-wave PRs. Closes the
   supply-chain blind spot.
3. **Add Pino `redact` config** (OPS-H4) — five lines, prevents the most likely
   credential leak (production log shipping).
4. **Adopt `changesets` + npm provenance** (CI-C4) — sets the release story for the
   life of the project; cheap to do now, expensive later.
5. **Expand `ci.yml` with a live-services integration job** (CI-C1) — would have
   caught the M4/A9 DDL-ordering regression before merge.
