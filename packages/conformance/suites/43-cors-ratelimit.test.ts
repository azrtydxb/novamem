import { describe, expect, it } from "vitest";
import { api } from "../src/client.js";
import { env } from "../src/env.js";

/**
 * Cross-origin and rate-limit middleware. Transcription source:
 * `packages/server/src/http.ts` — the `@fastify/cors` registration
 * (allow-list from `NOVAMEM_CORS_ORIGINS`, `credentials` on for an
 * explicit list) and the `@fastify/rate-limit` registration with its
 * `/health|/live|/ready` allowList. Read-only.
 *
 * The parity audit (§9.2) listed both as untested surfaces the Go server
 * lacked entirely under a green conformance run.
 *
 * The allowed origin defaults to `http://localhost:5173` — `config.ts`'s
 * own default for `corsOrigins`, i.e. what a target that never sets
 * NOVAMEM_CORS_ORIGINS actually serves. Override with
 * NOVAMEM_CORS_ALLOWED_ORIGIN.
 */

const ALLOWED = env.corsAllowedOrigin;
const REJECTED = "http://conformance-rejected-origin.invalid";

describe("CORS", () => {
  it("preflight from an allowed origin reflects the origin and allows credentials", async () => {
    const r = await api("/v1/search", {
      method: "OPTIONS",
      token: "",
      headers: {
        origin: ALLOWED,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(r.headers.get("access-control-allow-credentials")).toBe("true");
    // The reflected method list is the route table's, not the request's.
    expect(r.headers.get("access-control-allow-methods")).toBeTruthy();
    expect(r.headers.get("access-control-allow-methods")).toContain("POST");
    // Requested headers are echoed verbatim.
    expect(r.headers.get("access-control-allow-headers")).toBe(
      "authorization,content-type"
    );
    // Caching a per-origin decision without Vary would poison shared caches.
    expect(r.headers.get("vary") ?? "").toContain("Origin");
  });

  it("preflight from a rejected origin answers 204 but grants no origin", async () => {
    const r = await api("/v1/search", {
      method: "OPTIONS",
      token: "",
      headers: {
        origin: REJECTED,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
    // @fastify/cors still short-circuits the preflight — the denial is
    // the ABSENCE of access-control-allow-origin, which is what makes the
    // browser refuse the real request. A 4xx here would be wrong.
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(r.headers.get("vary") ?? "").toContain("Origin");
  });

  it("a non-preflight OPTIONS (no Origin, no Access-Control-Request-Method) is 400", async () => {
    // Not a CORS preflight, so @fastify/cors passes it through to the
    // router, which has no OPTIONS handler for the path.
    const r = await api("/v1/search", { method: "OPTIONS", token: "" });
    expect(r.status).toBe(400);
  });

  it("a simple request from an allowed origin carries the CORS response headers", async () => {
    const r = await api("/health", { token: "", headers: { origin: ALLOWED } });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(r.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("a simple request from a rejected origin succeeds but grants no origin", async () => {
    // Server-side the call is just a request; CORS only governs what the
    // BROWSER is then allowed to read. No allow-origin ⇒ unreadable.
    const r = await api("/health", {
      token: "",
      headers: { origin: REJECTED },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("rate limiting", () => {
  // ponytail: headers + exemption only, deliberately. Actually exhausting
  // the bucket is per-IP and per-process, so a test that drove a limited
  // route to 429 would leave every LATER suite in this run throttled
  // against the same target — the assertion would poison the run it lives
  // in. The per-account auth-failure limiter (5 strikes / 15 min) has the
  // same problem and is likewise not exhausted anywhere in this suite.
  it("a limited route advertises the x-ratelimit-* triple", async () => {
    // /v1/adoption rather than /v1/stats: same limiter, but stats runs a
    // per-namespace aggregation that can take tens of seconds on a loaded
    // shared oracle (see 10-data-plane's timeout note) — this test is
    // about headers, not about waiting for a report.
    const r = await api("/v1/adoption", { body: {} });
    expect(r.status).toBe(200);
    const limit = r.headers.get("x-ratelimit-limit");
    const remaining = r.headers.get("x-ratelimit-remaining");
    const reset = r.headers.get("x-ratelimit-reset");
    expect(limit, "x-ratelimit-limit").toBeTruthy();
    expect(remaining, "x-ratelimit-remaining").toBeTruthy();
    expect(reset, "x-ratelimit-reset").toBeTruthy();
    expect(Number(limit)).toBeGreaterThan(0);
    expect(Number(remaining)).toBeGreaterThanOrEqual(0);
    expect(Number(remaining)).toBeLessThan(Number(limit));
    // timeWindow is "1 minute" — the reset countdown can never exceed it.
    expect(Number(reset)).toBeGreaterThan(0);
    expect(Number(reset)).toBeLessThanOrEqual(60);
  });

  it("consecutive calls decrement the remaining budget", async () => {
    const first = await api<{ ok?: boolean }>("/v1/adoption", { body: {} });
    const second = await api<{ ok?: boolean }>("/v1/adoption", { body: {} });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = Number(first.headers.get("x-ratelimit-remaining"));
    const b = Number(second.headers.get("x-ratelimit-remaining"));
    // Strictly less unless the 1-minute window rolled between the two
    // calls (in which case the budget resets upward) — accept either, but
    // never "unchanged", which would mean the limiter isn't counting.
    expect(b === a - 1 || b > a).toBe(true);
  });

  it("health probes are exempt from the limiter", async () => {
    for (const path of ["/health", "/live", "/ready"]) {
      const r = await api(path, { token: "" });
      expect(r.status).toBe(200);
      expect(
        r.headers.get("x-ratelimit-limit"),
        `${path} must not be counted`
      ).toBeNull();
      expect(
        r.headers.get("x-ratelimit-remaining"),
        `${path} must not be counted`
      ).toBeNull();
    }
  });
});
