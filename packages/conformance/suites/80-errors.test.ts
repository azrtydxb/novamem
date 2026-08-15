import { afterAll, describe, expect, it } from "vitest";

import { api, ns } from "../src/client.js";
import { env, skipUnless } from "../src/env.js";
import { ErrorBody } from "../src/schemas.js";

/**
 * Error-SHAPE contract: the Go server must reproduce these bodies
 * byte-for-byte where integrations match on them. Transcription sources:
 * `http.ts` error handler (zod envelope + generic 4xx/500 shapes),
 * `routes/context.ts` (confined-token message — load-bearing, the Go
 * client's conformance and NovaFlow match on it). Read-only.
 */

describe("error shapes", () => {
  // Every token this suite mints gets revoked. The read-only probe below
  // used to leak one per run: 18 live `conf-err-ro-*` tokens had piled up
  // on novamem-bench, each one a working credential and every one of them
  // cluttering the dashboard's per-token usage table.
  const mintedTokens: string[] = [];
  afterAll(async () => {
    const failed: string[] = [];
    for (const token of mintedTokens) {
      const r = await api<{ revoked: boolean }>("/v1/admin/tokens/revoke", {
        body: { token },
        token: env.adminToken,
      });
      // Fail loudly rather than leak quietly. A cleanup that swallows its
      // own errors is how the 18 tokens got there in the first place: the
      // run stays green while working credentials pile up on the target.
      if (r.status !== 200 || r.body?.revoked !== true) {
        failed.push(`${token.slice(0, 12)}… → ${r.status} ${JSON.stringify(r.body)}`);
      }
    }
    if (failed.length > 0) {
      throw new Error(
        `conformance leaked ${failed.length} live token(s) — revoke failed:\n  ${failed.join("\n  ")}`,
      );
    }
  });

  it("400: zod envelope with issues[] for a missing required field", async () => {
    const r = await api<{ error: string; issues: Array<{ path: string; message: string; code: string }> }>(
      "/v1/remember",
      { body: {} },
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid request body");
    expect(Array.isArray(r.body.issues)).toBe(true);
    const issue = r.body.issues.find((i) => i.path === "content");
    expect(issue).toBeTruthy();
  });

  it.skipIf(skipUnless(["user", "bearer"]))("401: no token → {error: \"unauthorized\"}", async () => {
    // /v1/remember rather than /v1/search: same 401 contract on the TS
    // oracle, but remember exists from Go slice 2 while search arrives in
    // slice 3 — the probe should test auth, not route existence.
    const r = await api<{ error: string }>("/v1/remember", { body: { content: "x" }, token: "" });
    expect(r.status).toBe(401);
    expect(ErrorBody.parse(r.body).error).toBe("unauthorized");
  });

  it.skipIf(skipUnless(["user"]))("403: read-only token write — exact message", async () => {
    const mint = await api<{ token: string }>("/v1/me/tokens", {
      body: { label: `conf-err-ro-${ns()}`, scope: "read_only" },
      token: env.adminToken,
    });
    expect(mint.status).toBe(201);
    mintedTokens.push(mint.body.token);
    const r = await api<{ error: string }>("/v1/remember", {
      body: { content: "a write that the read-only token must not perform" },
      token: mint.body.token,
    });
    expect(r.status).toBe(403);
    // Message IS contract: clients branch on it.
    expect(r.body.error).toBe("read-only token");
  });

  it("404: unknown memory id on update", async () => {
    const r = await api<{ error: string }>(`/v1/memories/conf-nonexistent-${ns()}`, {
      method: "PUT",
      body: { content: "updating a memory that does not exist anywhere" },
    });
    expect(r.status).toBe(404);
    ErrorBody.parse(r.body);
  });

  it("oversized content is refused with the zod envelope", async () => {
    // MAX_CONTENT_BYTES is 256KB (routes/schemas.ts). One byte over.
    const r = await api<{ error: string }>("/v1/remember", {
      body: { content: "x".repeat(256 * 1024 + 1) },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid request body");
  });

  it("429: write quota — loud skip unless quotas are enabled on the target", async (ctx) => {
    const usage = await api<{ entries: number; quota: { writesPerMinute: number | null } }>(
      "/v1/me/usage",
      { token: env.adminToken },
    );
    if (usage.status !== 200 || !usage.body.quota.writesPerMinute) {
      ctx.skip();
      return;
    }
    // ponytail: hammer loop bounded by the quota itself; only runs on
    // quota-enabled targets, so it can't spin unbounded on the bench.
    const limit = usage.body.quota.writesPerMinute;
    let last = 0;
    for (let i = 0; i <= limit + 1; i++) {
      const r = await api<{ error: string }>("/v1/remember", {
        body: { content: `quota probe fact number ${i} ${ns()}`, force: true },
        token: env.adminToken,
      });
      last = r.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});
