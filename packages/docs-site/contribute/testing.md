---
title: Testing
---

# Testing

novamem uses **vitest** across the workspace. ~200 unit + integration tests at the time of writing; CI gates every PR on green.

## Run

```bash
# Everything
pnpm test

# A single package
pnpm --filter @azrtydxb/novamem-server test

# A single file (watch mode)
pnpm --filter @azrtydxb/novamem-server test -- --watch engine.test.ts

# Pattern
pnpm --filter @azrtydxb/novamem-server test -- "neighbors|search"
```

## Layout

Tests live next to the source they test:

```
src/
├── engine/index.ts
├── engine/engine.test.ts        — engine logic
├── http.ts
├── http.test.ts                 — Fastify route tests via inject()
├── routes/mcp-sse.ts
├── routes/mcp-sse.test.ts       — real SSE handshake via fetch
├── ...
└── test-fakes.ts                — in-memory FakeWarmStore / FakeColdStore / FakeGraphStore
```

The fakes implement the same interfaces as the real stores. Tests usually wire them into a `MemoryEngine` and exercise the full call path without a database.

## Fakes vs real datastores

Almost every test uses fakes — fast, hermetic. A handful do real-network tests:

- `routes/mcp-sse.test.ts` — Fastify `listen()` + real `fetch()` with `AbortController` per session, because `app.inject()` buffers SSE indefinitely
- `warm-store/integration.test.ts` (when present) — gated on `RUN_DB_TESTS=1`, requires a live Postgres

## Patterns

### Engine test

```ts
import { describe, expect, it } from "vitest";
import { bench } from "./test-bench";

describe("engine.search", () => {
  it("fuses keyword + vector signals", async () => {
    const b = bench();
    const a = await b.engine.remember("public", { content: "Pascal likes coffee", force: true });
    const r = await b.engine.search("public", { query: "coffee preference", k: 5 });
    expect(r.results[0].id).toBe(a.id);
  });
});
```

`bench()` constructs an engine wired to in-memory fakes — see `test-bench.ts`.

### Route test (Fastify inject)

```ts
import { describe, expect, it } from "vitest";

describe("POST /v1/search", () => {
  it("rejects requests without a token", async () => {
    const { app } = await makeApp();
    const r = await app.inject({ method: "POST", url: "/v1/search", payload: {} });
    expect(r.statusCode).toBe(401);
  });
});
```

`makeApp()` builds a Fastify instance against the fakes and skips the rate limit.

### Real-network test (SSE)

For tests that need actual TCP (SSE concurrency caps, keepalive frames):

```ts
const port = await listen();
const ctrl = new AbortController();
const res = await fetch(`http://127.0.0.1:${port}/mcp/sse`, { signal: ctrl.signal });
// drain reader → assert frames → ctrl.abort() in afterAll
```

Use sparingly. The fakes-backed inject path is faster and covers most logic.

## Coverage

`pnpm test -- --coverage` (vitest-v8). Targets are not strictly enforced — focus on covering the failure modes instead of the percentage.

## Adding a regression test

When a bug is fixed, add a test that fails on the bad version and passes on the fix. Keep the test commented to point at the bug:

```ts
// Regression for the FalkorDB driver-decode error path
// ("expected List or Null but was Path/Edge"). The engine catches the
// throw and surfaces it as a degraded result.
it("degrades when graph.neighbors throws", async () => {
  // ...
});
```

The comment plus the assertion together document why the test exists.

## CI

`.github/workflows/ci.yml` runs:

1. `pnpm test` per package
2. `pnpm typecheck`
3. `pnpm lint`
4. `pnpm audit --audit-level=moderate`
5. Docker build + Trivy scan
6. CodeQL static analysis

Branch protection requires all checks green + branch up-to-date with main before merge.
