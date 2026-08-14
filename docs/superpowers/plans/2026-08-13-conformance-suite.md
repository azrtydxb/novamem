# Conformance Suite (Go migration slice 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A black-box conformance suite (`packages/conformance`) that exercises the full novamem HTTP + MCP surface against any URL, so a green run against the TS server becomes the oracle baseline for the Go rewrite.

**Architecture:** A standalone pnpm workspace package using vitest, driven entirely by env vars (`NOVAMEM_URL`, tokens, auth mode). It never imports server code — HTTP and MCP wire traffic only. An OpenAPI-driven coverage gate fails the suite when the live server exposes an endpoint the suite doesn't list, so the suite can't silently rot as features land.

**Tech Stack:** TypeScript, vitest, undici/fetch, `@modelcontextprotocol/sdk` client (for MCP transports), zod for response-shape assertions.

## Global Constraints

- The suite must run green against the **TypeScript server first** — the TS server is the oracle. A red test means the *test's expectation* is wrong, unless investigation shows a genuine TS bug (surface it to Pascal; never paper over it in the test).
- Deployment target for live runs is **novamem-bench on the kw cluster only** (plus local docker compose for development of the suite itself).
- No imports from `packages/server` — black-box only. Types are re-declared locally as zod schemas; drift between those schemas and the server IS the signal.
- Env contract (all suites): `NOVAMEM_URL` (required), `NOVAMEM_TEST_TOKEN` (data-plane bearer), `NOVAMEM_ADMIN_TOKEN` (admin bearer/session), `NOVAMEM_AUTH_MODE` = `none|bearer|user` (what the target is running; suites skip what the mode makes unreachable, loudly).
- Every test that writes data scopes it to a unique per-run namespace/project and cleans up in `afterAll`.
- Node >= 20.19, ESM, repo lint/typecheck conventions (`pnpm -r lint`, `tsc --noEmit`).
- Commit messages: plain conventional commits, **no AI attribution trailers** (repo rule).

## File Structure

```
packages/conformance/
  package.json              name @azrtydxb/novamem-conformance, private
  tsconfig.json             extends ../../tsconfig.base.json
  vitest.config.ts          sequential (fileParallelism false), 30s timeout
  src/
    env.ts                  env parsing + mode/skip helpers
    client.ts               api()/adminApi() HTTP helpers, ns() generator
    schemas.ts              zod response schemas shared across suites
    coverage.ts             coverage manifest (path+method -> suite name)
  suites/
    00-meta.test.ts         /health, /live, /ready, /openapi.json + coverage gate
    10-data-plane.test.ts   remember/recent/memories/:id/forget/stats/TTL
    20-search.test.ts       seeded corpus; search/context/neighbors/context-prefix
    30-ingest.test.ts       capture/observe/session-recap/evaluate/hygiene/adoption
    40-auth.test.ts         mode gates, rotate-token, confined + read-only tokens
    50-me.test.ts           me/metrics|tokens|projects|members|active-project|today|onboarding
    60-admin.test.ts        admin users/audit-log/metrics/prom/tokens-revoke + decay/dream/reap
    70-mcp-streamable.test.ts  initialize, tools/list snapshot (21 tools), tool round-trips
    71-mcp-sse.test.ts      legacy SSE transport handshake + one round-trip
    80-errors.test.ts       error-shape contract: 400/401/403/404/413/429 bodies
  reference/
    tools.snapshot.json     checked-in MCP tools/list snapshot
scripts/ (repo root)        conformance-local.sh — compose up, run, teardown
```

---

### Task 1: Package scaffold + HTTP harness + meta suite

**Files:**
- Create: `packages/conformance/package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `packages/conformance/src/env.ts`, `src/client.ts`
- Test: `packages/conformance/suites/00-meta.test.ts`

**Interfaces:**
- Produces: `env` object `{ url, testToken, adminToken, authMode }`; `api<T>(path, opts?) -> {status, body, headers}`; `ns()` -> unique namespace string; `skipUnless(mode: AuthMode[])` helper. All later suites consume exactly these.

- [ ] **Step 1: Scaffold the package**

`package.json`:
```json
{
  "name": "@azrtydxb/novamem-conformance",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "eslint suites src"
  },
  "devDependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "vitest": "^4.1.10",
    "zod": "^3.24.0"
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    fileParallelism: false,   // suites share one live server; run in order
    testTimeout: 30_000,
    include: ["suites/**/*.test.ts"],
  },
});
```

- [ ] **Step 2: Write `src/env.ts`**

```ts
export type AuthMode = "none" | "bearer" | "user";

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`conformance: ${name} is required`);
  return v;
}

export const env = {
  url: req("NOVAMEM_URL").replace(/\/$/, ""),
  testToken: process.env.NOVAMEM_TEST_TOKEN ?? "",
  adminToken: process.env.NOVAMEM_ADMIN_TOKEN ?? "",
  authMode: (process.env.NOVAMEM_AUTH_MODE ?? "user") as AuthMode,
};
```

- [ ] **Step 3: Write `src/client.ts`** (mirror the proven harness in `packages/server/tests/integration.test.ts:31-56`, but returning headers too)

```ts
import { env } from "./env.js";

const RUN = `conf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;
export const ns = (): string => `${RUN}-${++seq}`;

export interface ApiResult<T> { status: number; body: T; headers: Headers }

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<ApiResult<T>> {
  const token = opts.token ?? env.testToken;
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const r = await fetch(`${env.url}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON stays string */ }
  return { status: r.status, body: body as T, headers: r.headers };
}

export const adminApi = <T = unknown>(path: string, opts: Parameters<typeof api>[1] = {}) =>
  api<T>(path, { ...opts, token: env.adminToken });
```

- [ ] **Step 4: Write the meta suite** `suites/00-meta.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { api } from "../src/client.js";

describe("meta endpoints", () => {
  for (const path of ["/health", "/live", "/ready"]) {
    it(`GET ${path} is 200 without auth`, async () => {
      const r = await api(path, { token: "" });
      expect(r.status).toBe(200);
    });
  }

  it("GET /openapi.json serves a valid OpenAPI doc", async () => {
    const r = await api<{ openapi: string; paths: Record<string, unknown> }>(
      "/openapi.json", { token: "" });
    expect(r.status).toBe(200);
    expect(r.body.openapi).toMatch(/^3\./);
    expect(Object.keys(r.body.paths).length).toBeGreaterThan(20);
  });
});
```

- [ ] **Step 5: Run against the local TS oracle**

Bring up the stack (repo root): `docker compose up -d`, then `pnpm --filter @azrtydxb/novamem-server dev` (or the compose-provided server), then:

Run: `NOVAMEM_URL=http://localhost:7778 NOVAMEM_AUTH_MODE=user NOVAMEM_TEST_TOKEN=<nm_ token> pnpm --filter @azrtydxb/novamem-conformance test suites/00-meta.test.ts`
Expected: PASS (4 tests). If `/health` vs `/live` naming differs, fix the test to match reality — check `packages/server/src/http.ts:412`.

- [ ] **Step 6: Commit**

```bash
git add packages/conformance
git commit -m "feat(conformance): package scaffold, HTTP harness, meta suite"
```

---

### Task 2: OpenAPI coverage gate

**Files:**
- Create: `packages/conformance/src/coverage.ts`
- Modify: `packages/conformance/suites/00-meta.test.ts` (append gate test)

**Interfaces:**
- Produces: `COVERAGE: Record<string, string>` mapping `"METHOD /path"` → owning suite file. Later suites add their endpoints here as they are written.

- [ ] **Step 1: Write `src/coverage.ts`** — start with only what Task 1 covers:

```ts
/** Every live endpoint must appear here, mapped to the suite that owns it.
 *  The gate test fails on any live endpoint missing from this manifest —
 *  that is the mechanism that keeps the conformance suite honest as
 *  features land (spec §3, §7). */
export const COVERAGE: Record<string, string> = {
  "GET /health": "00-meta",
  "GET /live": "00-meta",
  "GET /ready": "00-meta",
  "GET /openapi.json": "00-meta",
};

/** Endpoints deliberately not conformance-tested; each needs a reason. */
export const EXEMPT: Record<string, string> = {
  // e.g. "GET /favicon.ico": "static asset, not API contract",
};
```

- [ ] **Step 2: Append the gate test to `00-meta.test.ts`**

```ts
it("every live endpoint is claimed by a suite (coverage gate)", async () => {
  const r = await api<{ paths: Record<string, Record<string, unknown>> }>(
    "/openapi.json", { token: "" });
  const live = Object.entries(r.body.paths).flatMap(([p, methods]) =>
    Object.keys(methods).map((m) => `${m.toUpperCase()} ${p}`));
  const claimed = new Set([...Object.keys(COVERAGE), ...Object.keys(EXEMPT)]);
  const unclaimed = live.filter((e) => !claimed.has(e));
  expect(unclaimed, `unclaimed endpoints:\n${unclaimed.join("\n")}`).toEqual([]);
});
```

- [ ] **Step 3: Run it — it MUST fail** (dozens of unclaimed endpoints). That failure list is the authoritative work list for Tasks 3–8. Paste it into the commit message body.

Run: `NOVAMEM_URL=http://localhost:7778 ... pnpm --filter @azrtydxb/novamem-conformance test suites/00-meta.test.ts`
Expected: FAIL with the unclaimed-endpoint list.

- [ ] **Step 4: Temporarily mark the gate `it.todo`-style?** No — instead add every currently-live endpoint to `COVERAGE` now, mapped to its **planned** suite (from the File Structure table). The gate passes immediately and each later task's definition of done includes "the endpoints this suite claims actually have tests". This keeps the gate always-on.

- [ ] **Step 5: Re-run; expect PASS. Commit**

```bash
git add packages/conformance
git commit -m "feat(conformance): OpenAPI coverage gate with full endpoint manifest"
```

---

### Task 3: Data-plane CRUD suite

**Files:**
- Create: `packages/conformance/src/schemas.ts`, `suites/10-data-plane.test.ts`

**Interfaces:**
- Consumes: `api`, `ns`, `env` from Task 1.
- Produces: zod schemas `MemoryEntry`, `ErrorBody` in `src/schemas.ts` reused by every later suite.

- [ ] **Step 1: Read the oracle's shapes.** Read `packages/server/src/routes/data-plane.ts` and `routes/schemas.ts` for the exact request/response schemas of `/v1/remember`, `/v1/recent`, `/v1/memories/:id`, `/v1/forget`, `/v1/stats`. Transcribe them into `src/schemas.ts` as zod schemas (loose — `.passthrough()` — assert what matters, tolerate additions).

```ts
import { z } from "zod";

export const MemoryEntry = z.object({
  id: z.string().min(1),
  content: z.string(),
  namespace: z.string().optional(),
  tier: z.enum(["warm", "cold"]).optional(),
  createdAt: z.string().optional(),
  expiresAt: z.string().nullable().optional(),
}).passthrough();

export const ErrorBody = z.object({ error: z.string() }).passthrough();
```
(Adjust fields to what `routes/schemas.ts` actually declares — the transcription step is the point.)

- [ ] **Step 2: Write the suite** — full lifecycle in one namespace:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { api, ns } from "../src/client.js";
import { MemoryEntry, ErrorBody } from "../src/schemas.js";

const NS = ns();
let id: string;

describe("data plane CRUD", () => {
  it("remember stores and returns an entry", async () => {
    const r = await api<{ id: string }>("/v1/remember", {
      body: { content: `conformance fact ${NS}`, namespace: NS },
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toBeTruthy();
    id = r.body.id;
  });

  it("recent lists it", async () => {
    const r = await api<{ entries: unknown[] }>("/v1/recent", {
      body: { namespace: NS, limit: 10 },
    });
    expect(r.status).toBe(200);
    const entries = r.body.entries.map((e) => MemoryEntry.parse(e));
    expect(entries.some((e) => e.id === id)).toBe(true);
  });

  it("GET /v1/memories/:id returns the entry", async () => {
    const r = await api(`/v1/memories/${id}`);
    expect(r.status).toBe(200);
    MemoryEntry.parse(r.body);
  });

  it("remember with expiresAt honors TTL shape", async () => {
    const r = await api<{ id: string; expiresAt?: string }>("/v1/remember", {
      body: {
        content: `ttl fact ${NS}`,
        namespace: NS,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    expect(r.status).toBe(200);
  });

  it("forget deletes; entry then 404s", async () => {
    const del = await api("/v1/forget", { body: { id } });
    expect(del.status).toBe(200);
    const gone = await api(`/v1/memories/${id}`);
    expect(gone.status).toBe(404);
    ErrorBody.parse(gone.body);
  });

  it("stats responds with counts", async () => {
    const r = await api("/v1/stats");
    expect(r.status).toBe(200);
  });

  afterAll(async () => {
    // best-effort namespace cleanup via forget-by-namespace if supported,
    // else entries expire with the run DB (local compose is disposable)
  });
});
```

- [ ] **Step 3: Run against oracle; reconcile.** Every mismatch = fix the test's expectation to the observed contract (and tighten the zod schema). Re-run until green.

Run: `... pnpm --filter @azrtydxb/novamem-conformance test suites/10-data-plane.test.ts`
Expected: PASS.

- [ ] **Step 4: Verify this suite's `COVERAGE` claims are real** — every endpoint mapped to `10-data-plane` in the manifest now has at least one test hitting it (add tests for any stragglers, e.g. write-quota 429 lives in `80-errors`, so re-map it there).

- [ ] **Step 5: Commit**

```bash
git add packages/conformance
git commit -m "feat(conformance): data-plane CRUD + TTL suite"
```

---

### Task 4: Search suite with seeded corpus

**Files:**
- Create: `packages/conformance/suites/20-search.test.ts`

**Interfaces:**
- Consumes: `api`, `ns`, `MemoryEntry`.
- Produces: `seedCorpus(nsName): Promise<string[]>` local helper pattern copied by suite 30 (kept in-file; DRY across files is not worth a shared fixture module yet).

- [ ] **Step 1: Write the suite.** Seed a deterministic 8-entry corpus with clearly separable topics, then assert *rank-tolerant* expectations (membership and top-k containment — never exact order):

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { api, ns } from "../src/client.js";

const NS = ns();
const CORPUS = [
  "The kw cluster ingress uses Cilium with kube-vip for the VIP",
  "Longhorn provides replicated block storage for the cluster",
  "Pascal prefers espresso over filter coffee in the morning",
  "The espresso machine is a Lelit Bianca with flow control",
  "novamem uses a warm Postgres tier and a cold vector tier",
  "The vector tier supports pgvector and Qdrant backends",
  "Tax filing deadline for 2026 is in April",
  "The cat's vet appointment is on Fridays",
];

beforeAll(async () => {
  for (const content of CORPUS) {
    const r = await api("/v1/remember", { body: { content, namespace: NS } });
    if (r.status !== 200) throw new Error(`seed failed: ${r.status}`);
  }
});

describe("hybrid search", () => {
  it("finds topical matches in top-k", async () => {
    const r = await api<{ results: Array<{ content: string; score: number }> }>(
      "/v1/search", { body: { query: "coffee machine", namespace: NS, limit: 4 } });
    expect(r.status).toBe(200);
    const texts = r.body.results.map((x) => x.content);
    expect(texts.some((t) => t.includes("espresso"))).toBe(true);
  });

  it("scores are monotonically non-increasing", async () => {
    const r = await api<{ results: Array<{ score: number }> }>(
      "/v1/search", { body: { query: "vector storage", namespace: NS, limit: 8 } });
    const scores = r.body.results.map((x) => x.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("neighbors returns graph-adjacent entries for a seeded id", async () => {
    const list = await api<{ entries: Array<{ id: string }> }>(
      "/v1/recent", { body: { namespace: NS, limit: 1 } });
    const id = list.body.entries[0].id;
    const r = await api("/v1/neighbors", { body: { id } });
    expect(r.status).toBe(200);
  });

  it("context and context-prefix respond 200 with token-budgeted payloads", async () => {
    const c = await api("/v1/context", { body: { query: "cluster storage", namespace: NS } });
    expect(c.status).toBe(200);
    const p = await api("/v1/context-prefix", { body: { namespace: NS } });
    expect(p.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run against oracle; reconcile field names** (`results` vs `entries`, score field name) per `routes/schemas.ts`. Note in a comment which embedding endpoint the oracle used — differential runs later must pin the same one.

Run: `... pnpm --filter @azrtydxb/novamem-conformance test suites/20-search.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/conformance
git commit -m "feat(conformance): seeded hybrid-search suite with rank-tolerant assertions"
```

---

### Task 5: Ingest/maintenance suite

**Files:**
- Create: `packages/conformance/suites/30-ingest.test.ts`

**Interfaces:**
- Consumes: `api`, `ns`, `adminApi`.

- [ ] **Step 1: Read `routes/data-plane.ts` handlers for** `/v1/capture`, `/v1/observe`, `/v1/session-recap`, `/v1/evaluate`, `/v1/hygiene`, `/v1/adoption`, and admin-gated `/v1/decay`, `/v1/dream-cycle`, `/v1/reap-orphans`. Transcribe minimal valid request bodies from their zod request schemas.

- [ ] **Step 2: Write the suite** — one happy-path call per endpoint asserting status + response schema; capture/observe assert the worthiness-gate behavior (a trivial "ok thanks" capture should be rejected or stored-as-skipped per the oracle's actual contract — record which). Admin-gated endpoints: assert 401/403 with the data-plane token, then 200 via `adminApi` when `NOVAMEM_ADMIN_TOKEN` is set, `it.skip` otherwise (loud skip).

- [ ] **Step 3: Run against oracle until green; commit**

```bash
git add packages/conformance
git commit -m "feat(conformance): ingest + maintenance endpoint suite"
```

---

### Task 6: Auth suite

**Files:**
- Create: `packages/conformance/suites/40-auth.test.ts`

**Interfaces:**
- Consumes: `api`, `env`. Produces nothing new.

- [ ] **Step 1: Write mode-aware gate tests:**

```ts
import { describe, expect, it } from "vitest";
import { api } from "../src/client.js";
import { env } from "../src/env.js";

describe("auth gates", () => {
  it("data plane without a token is 401 (unless mode=none)", async () => {
    const r = await api("/v1/recent", { body: { limit: 1 }, token: "" });
    expect(r.status).toBe(env.authMode === "none" ? 200 : 401);
  });

  it("garbage bearer is 401 with error body", async () => {
    const r = await api("/v1/recent", { body: { limit: 1 }, token: "nm_bogus" });
    if (env.authMode === "none") return;
    expect(r.status).toBe(401);
  });

  it("data-plane token cannot reach /v1/admin/metrics", async () => {
    const r = await api("/v1/admin/metrics");
    expect([401, 403]).toContain(r.status);
  });
});
```

- [ ] **Step 2: Add rotate-token round-trip** (user mode only): POST `/v1/auth/rotate-token`, assert old token stops working and new token works, then rotate back is impossible (old is dead) — read `routes/auth.ts:23` for the exact request/response first. Guard with `env.authMode === "user"`; otherwise loud `it.skip`.

- [ ] **Step 3: Project-confined token test** (user mode + admin token available): mint a project-confined token via the oracle's token-mint route (`/v1/me/tokens`, see `routes/me.ts:135`), then assert a data-plane call targeting another project 403s with `"token is confined to its project"` (`routes/context.ts:218`), and that the confined project works. Read-only token: assert a write POST is rejected, a read POST (`/v1/search`) passes.

- [ ] **Step 4: Run against oracle until green; commit**

```bash
git add packages/conformance
git commit -m "feat(conformance): auth-mode, rotate-token, confined/read-only token suite"
```

---

### Task 7: /v1/me suite (user mode)

**Files:**
- Create: `packages/conformance/suites/50-me.test.ts`

**Interfaces:**
- Consumes: `api`, `ns`, `env`.

- [ ] **Step 1: Read `routes/me.ts`** for exact shapes of: metrics, metrics/history, tokens (list/create/delete `:hash`), projects (list/create/get/delete), members (list/add/remove), active-project (get/set/clear), today, onboarding.

- [ ] **Step 2: Write the suite as one lifecycle:** create project → set active → remember into it → today shows activity → member add/remove (skip if single-user) → token create/list/delete → project delete. Whole file guarded: `env.authMode === "user"` else loud skip describing why.

- [ ] **Step 3: Run against oracle until green; commit**

```bash
git add packages/conformance
git commit -m "feat(conformance): /v1/me lifecycle suite"
```

---

### Task 8: Admin suite

**Files:**
- Create: `packages/conformance/suites/60-admin.test.ts`

**Interfaces:**
- Consumes: `adminApi`, `api`.

- [ ] **Step 1: Read `routes/admin.ts`** for `/v1/admin/{tokens/revoke,users,audit-log,metrics,metrics/prom}` and `http.ts` for `/v1/admin/health/deep`.

- [ ] **Step 2: Write the suite:** each endpoint 200s with admin credential and is 401/403 with the data-plane token; `metrics/prom` returns `text/plain` Prometheus exposition (assert a known metric name prefix); `audit-log` contains the token-revoke event after revoking a throwaway token minted in the test. Skips loudly when `NOVAMEM_ADMIN_TOKEN` unset.

- [ ] **Step 3: Run against oracle until green; commit**

```bash
git add packages/conformance
git commit -m "feat(conformance): admin-plane suite"
```

---

### Task 9: MCP streamable suite + tools snapshot

**Files:**
- Create: `packages/conformance/suites/70-mcp-streamable.test.ts`
- Create: `packages/conformance/reference/tools.snapshot.json`

**Interfaces:**
- Consumes: `env`. Uses `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport`.

- [ ] **Step 1: Write connection + snapshot test:**

```ts
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { env } from "../src/env.js";
import { readFileSync } from "node:fs";

async function connect(): Promise<Client> {
  const client = new Client({ name: "novamem-conformance", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${env.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${env.testToken}` } },
  });
  await client.connect(transport);
  return client;
}

describe("MCP streamable", () => {
  it("tools/list matches the checked-in snapshot (21 tools)", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const snapshot = JSON.parse(
      readFileSync(new URL("../reference/tools.snapshot.json", import.meta.url), "utf8"));
    expect(names).toEqual(snapshot.names);
    await client.close();
  });

  it("memory_remember → memory_search → memory_forget round-trip", async () => {
    const client = await connect();
    const fact = `mcp conformance fact ${Date.now()}`;
    const stored = await client.callTool({ name: "memory_remember",
      arguments: { content: fact } });
    expect(stored.isError ?? false).toBe(false);
    const found = await client.callTool({ name: "memory_search",
      arguments: { query: "mcp conformance fact" } });
    expect(JSON.stringify(found.content)).toContain("conformance fact");
    await client.close();
  });
});
```

- [ ] **Step 2: Generate the snapshot from the oracle** (one-off script run, output committed): connect, `listTools()`, write `{ names: [...], schemas: {...} }` to `reference/tools.snapshot.json`. The 21 names come from `packages/server/src/mcp-tools.ts` (`memory_*` ×14, `project_*` ×7).

- [ ] **Step 3: Add spec-guard tests** from `routes/mcp-spec-guards.ts` behaviors: unknown tool name → JSON-RPC error not crash; malformed arguments → tool error with message; missing session on stateful call behaves per guard. Read the guard file first; one test per guard.

- [ ] **Step 4: Run against oracle until green; commit**

```bash
git add packages/conformance
git commit -m "feat(conformance): MCP streamable suite with tools snapshot + spec guards"
```

---

### Task 10: MCP SSE (legacy transport) suite

**Files:**
- Create: `packages/conformance/suites/71-mcp-sse.test.ts`

**Interfaces:**
- Consumes: same as Task 9 but `SSEClientTransport` against `/mcp/sse`.

- [ ] **Step 1: Write it:** connect via `SSEClientTransport(new URL(`${env.url}/mcp/sse`))` with the bearer header, `listTools()` must equal the same snapshot, one `memory_stats` call round-trips. That's the whole suite — SSE is legacy; parity of handshake + one call is the contract.

- [ ] **Step 2: Run against oracle until green; commit**

```bash
git add packages/conformance
git commit -m "feat(conformance): MCP legacy SSE transport suite"
```

---

### Task 11: Error-shape contract suite

**Files:**
- Create: `packages/conformance/suites/80-errors.test.ts`

**Interfaces:**
- Consumes: `api`, `ErrorBody` schema.

- [ ] **Step 1: Write one test per status class, asserting the exact JSON error shape** the Go server must reproduce:

- 400: `/v1/remember` with `{}` (missing content) — assert zod-style error body shape
- 401: no token (user/bearer mode)
- 403: project-confined violation (reuse Task 6 helper approach) and read-only-token write
- 404: `/v1/memories/nonexistent-id`
- 413/oversized: `/v1/remember` with content larger than the configured max (read the limit from `config.ts`; skip if unlimited)
- 429: hammer `/v1/remember` past the write quota (only when quotas enabled on target; read quota headroom from the usage endpoint first; loud skip otherwise)

Each assertion pins `status`, `ErrorBody.parse`, and any load-bearing message text (e.g. the confined-token message) — message text IS contract for messages the integrations match on; otherwise assert shape only.

- [ ] **Step 2: Run against oracle until green; commit**

```bash
git add packages/conformance
git commit -m "feat(conformance): error-shape contract suite"
```

---

### Task 12: Local runner script, docs, baseline record

**Files:**
- Create: `scripts/conformance-local.sh`
- Create: `packages/conformance/README.md`
- Modify: root `package.json` (add `"conformance": "pnpm --filter @azrtydxb/novamem-conformance test"`)

- [ ] **Step 1: Write `scripts/conformance-local.sh`** — compose up, wait for `/ready`, run full suite, teardown:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose up -d
trap 'docker compose down' EXIT
URL="${NOVAMEM_URL:-http://localhost:7778}"
for i in $(seq 1 60); do
  curl -fsS "$URL/ready" >/dev/null 2>&1 && break
  sleep 2
  [ "$i" = 60 ] && { echo "server never became ready" >&2; exit 1; }
done
NOVAMEM_URL="$URL" pnpm --filter @azrtydxb/novamem-conformance test
```

- [ ] **Step 2: Write `README.md`** — env contract table, how to run locally, how to run against novamem-bench (URL + where tokens come from: the tenant-admin flow), the oracle rule (red test = wrong test unless proven TS bug), and the coverage-gate rule (new endpoint ⇒ claim it in `COVERAGE` with a real test — spec §7).

- [ ] **Step 3: Full baseline runs — both targets:**

Run: `./scripts/conformance-local.sh`
Expected: full suite PASS locally.

Run: `NOVAMEM_URL=<novamem-bench URL> NOVAMEM_AUTH_MODE=user NOVAMEM_TEST_TOKEN=... NOVAMEM_ADMIN_TOKEN=... pnpm conformance`
Expected: full suite PASS against novamem-bench. This green run **is** the slice-0 deliverable — record the run output summary in the PR description.

- [ ] **Step 4: Commit, open PR**

```bash
git add scripts/conformance-local.sh packages/conformance/README.md package.json
git commit -m "feat(conformance): local runner, docs, baseline green on novamem-bench"
```

PR per repo rules: resolve every Copilot/Claude review comment before merge; no auto-merge until review comments addressed.

---

## Deferred (explicitly not in slice 0)

- CI job wiring (compose in CI) — first Go slice PR adds it so both servers run in one workflow.
- Differential ranking runs — need the Go server to exist (slice 3).
- `/v1/me/changes` + export/import conformance — those endpoints are on `feat/export-import`; add their tests (and `COVERAGE` claims) in the same PR that merges that branch, per the feature-freeze policy (spec §7).

## Self-review notes

- Spec coverage: spec §3 lists data plane, me, admin, auth flows, MCP both transports, quotas, TTL, changelog, export/import. All have tasks except changelog/export/import (deferred with reason above — they are not on main yet) and quota-429 (Task 11). Coverage gate (Task 2) enforces the rest mechanically.
- Types: `api`/`adminApi`/`ns`/`env` signatures consistent across tasks; suites only consume Task 1's interfaces.
- The 21-tool count corrects the spec's "15 tools" — spec amended in the same commit as this plan.
