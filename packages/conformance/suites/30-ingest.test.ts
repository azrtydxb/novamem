import { afterAll, describe, expect, it } from "vitest";
import { adminCookieApi, api, ns } from "../src/client.js";
import { env } from "../src/env.js";
import {
  CaptureResponse,
  DecayResponse,
  DreamCycleResponse,
  ErrorBody,
  EvaluateResponse,
  HygieneResponse,
  ObserveResponse,
  ReapOrphansResponse,
  SessionRecapResponse,
} from "../src/schemas.js";

/**
 * Read-only transcription source: `packages/server/src/routes/data-plane.ts`
 * + `routes/schemas.ts` + the corresponding `engine/index.ts` methods
 * (`capture`, `hygieneReport`, `evaluateMemoryQuality`, `decay`,
 * `dreamCycle`, `reapOrphans`, `runObserver`), read-only, never imported.
 *
 * Admin gating, verified against source rather than assumed from the task
 * brief: `requireOperator` (context.ts) delegates to `requireAdmin` in
 * `user` auth mode, which checks `req.dashUser` — a Better-Auth *session*,
 * never a bearer token. `http.ts`'s `wantsDashUser` allowlist that resolves
 * an `nm_…` bearer into a `dashUser` only covers `/v1/auth/*`, `/v1/me/*`,
 * `/v1/admin/*` — NOT the maintenance routes. So a data-plane bearer can
 * never satisfy `requireOperator` here, admin token or not; only the
 * session cookie (`adminCookieApi`) can. This applies to all four operator
 * routes, including `/v1/observe` — the task brief's brief only names
 * decay/dream-cycle/reap-orphans as "admin-gated", but the source shows
 * `/v1/observe` behind the identical `requireOperator` call.
 *
 * decay/dream-cycle/reap-orphans/observe run REAL maintenance against the
 * shared bench oracle's live DB. They are idempotent and cheap on this
 * small dataset, but each is invoked at most ONCE in this file (a single
 * `it()` each) — no loops, no retries.
 */

const NS = ns();
const createdIds: string[] = [];

describe("ingest pipeline", () => {
  it("POST /v1/capture stores a substantive fact", async () => {
    const r = await api<unknown>("/v1/capture", {
      body: {
        content: `The conformance suite's ingest test namespace is ${NS}, created for verifying the capture endpoint`,
        namespace: NS,
      },
    });
    expect(r.status).toBe(201);
    const parsed = CaptureResponse.parse(r.body);
    expect(parsed.id).toBeTruthy();
    if (parsed.id) createdIds.push(parsed.id);
  });

  it("POST /v1/capture rejects trivial filler via the worthiness gate", async () => {
    // "ok thanks" is 9 chars — under shouldReject()'s 12-char floor, so it
    // is rejected as "too short — not durable knowledge" before ever
    // reaching the embedder. No id is minted, so there is nothing to
    // dedupe or forget; the observable contract is id:null + rejected set.
    const r = await api<unknown>("/v1/capture", {
      body: { content: "ok thanks", namespace: NS },
    });
    expect(r.status).toBe(201);
    const parsed = CaptureResponse.parse(r.body);
    expect(parsed.id).toBeNull();
    expect(parsed.rejected).toBeTruthy();
  });

  it("POST /v1/session-recap ingests typed recap items as durable memories", async () => {
    const r = await api<unknown>("/v1/session-recap", {
      body: {
        namespace: NS,
        other: [
          `Session recap conformance fact for namespace ${NS}: the ingest suite exercises session-recap`,
        ],
      },
    });
    expect(r.status).toBe(201);
    const parsed = SessionRecapResponse.parse(r.body);
    expect(parsed.saved).toBe(1);
    expect(parsed.results).toHaveLength(1);
    const [result] = parsed.results;
    expect(result?.id).toBeTruthy();
    if (result?.id) createdIds.push(result.id);
  });

  it("POST /v1/evaluate runs the built-in memory-quality suite", async () => {
    // hygieneReport's pairwise Jaccard/contradiction scan (called inside
    // evaluateMemoryQuality) is O(n^2) over the scanned rows and the shared
    // bench's store is not tiny — same slow-under-load story as /v1/stats
    // (task-3 report), so this gets the same kind of generous headroom
    // rather than a tight default timeout.
    const r = await api<unknown>("/v1/evaluate", { body: {} });
    expect(r.status).toBe(200);
    const parsed = EvaluateResponse.parse(r.body);
    expect(parsed.suite).toBe("core");
    expect(parsed.cases.length).toBeGreaterThan(0);
    expect(parsed.summary.total).toBe(parsed.cases.length);
  }, 60_000);

  it("POST /v1/hygiene returns a scan-shaped report", async () => {
    const r = await api<unknown>("/v1/hygiene", { body: { k: 5 } });
    expect(r.status).toBe(200);
    const parsed = HygieneResponse.parse(r.body);
    expect(parsed.summary.scanned).toBeGreaterThanOrEqual(0);
  }, 60_000);

  it("POST /v1/adoption returns a diagnostics report without auth beyond the data-plane token", async () => {
    const r = await api<unknown>("/v1/adoption", { body: {} });
    expect(r.status).toBe(200);
    expect(typeof r.body).toBe("object");
  });
});

describe("operator-gated maintenance", () => {
  const hasAdminCookie = Boolean(env.adminCookie);

  it.skipIf(!hasAdminCookie)(
    "POST /v1/observe: 401 with the data-plane token, 200/503 with the admin session cookie",
    async () => {
      const denied = await api<unknown>("/v1/observe", { body: {} });
      expect(denied.status).toBe(401);
      ErrorBody.parse(denied.body);

      const allowed = await adminCookieApi<unknown>("/v1/observe", { body: {} });
      expect([200, 503]).toContain(allowed.status);
      if (allowed.status === 200) {
        ObserveResponse.parse(allowed.body);
      } else {
        ErrorBody.parse(allowed.body);
      }
    },
    60_000,
  );

  it.skipIf(!hasAdminCookie)(
    "POST /v1/decay: 401 with the data-plane token, 200 with the admin session cookie",
    async () => {
      const denied = await api<unknown>("/v1/decay", { body: {} });
      expect(denied.status).toBe(401);
      ErrorBody.parse(denied.body);

      const allowed = await adminCookieApi<unknown>("/v1/decay", { body: {} });
      expect(allowed.status).toBe(200);
      DecayResponse.parse(allowed.body);
    },
    // Observed a >60s stall on the shared bench (root cause not isolated —
    // possibly queued behind other requests' embedding/DB work on this
    // small single-instance oracle); the decay SQL itself is a single bulk
    // statement and normally answers in well under a second (verified
    // ad hoc via curl). Generous headroom here rather than a tight bound,
    // matching the /v1/stats precedent in 10-data-plane.test.ts.
    120_000,
  );

  // Observed on the shared bench oracle: a single real run took
  // durationMs 346816 (~5m47s) — dream-cycle walks up to 5000 warm
  // entries plus up to 1000 facts through real embeddings and an LLM
  // judge per candidate cluster (factClustersJudged: 118 in that run), so
  // multi-minute latency is the actual contract here, not a fluke. Give
  // it a timeout with real headroom above the observed run rather than
  // treating slowness as a bug; the assertion itself stays exact.
  it.skipIf(!hasAdminCookie)(
    "POST /v1/dream-cycle: 401 with the data-plane token, 200 with the admin session cookie",
    async () => {
      // No body schema on this route, and `api()` defaults to GET when no
      // body is given — this route only registers POST, so an implicit
      // GET would 404 rather than exercise the auth gate. Force POST.
      const denied = await api<unknown>("/v1/dream-cycle", { method: "POST" });
      expect(denied.status).toBe(401);
      ErrorBody.parse(denied.body);

      const allowed = await adminCookieApi<unknown>("/v1/dream-cycle", { method: "POST" });
      expect(allowed.status).toBe(200);
      DreamCycleResponse.parse(allowed.body);
    },
    600_000,
  );

  it.skipIf(!hasAdminCookie)(
    "POST /v1/reap-orphans: 401 with the data-plane token, 200 with the admin session cookie",
    async () => {
      // Same GET-default trap as dream-cycle above — force POST.
      const denied = await api<unknown>("/v1/reap-orphans", { method: "POST" });
      expect(denied.status).toBe(401);
      ErrorBody.parse(denied.body);

      const allowed = await adminCookieApi<unknown>("/v1/reap-orphans", { method: "POST" });
      expect(allowed.status).toBe(200);
      ReapOrphansResponse.parse(allowed.body);
    },
    60_000,
  );

  if (!hasAdminCookie) {
    // Loud skip: no silent green when the admin session cookie isn't
    // configured for this oracle run.
    it.skip("operator-gated maintenance requires NOVAMEM_ADMIN_COOKIE — skipped", () => {});
  }
});

afterAll(async () => {
  await Promise.all(
    createdIds.map((id) => api("/v1/forget", { body: { id } }).catch(() => {})),
  );
});
