import { createHash } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";
import { adminCookieApi, api, ns } from "../src/client.js";
import { env, hasAdminIdentity } from "../src/env.js";
import { ErrorBody } from "../src/schemas.js";

/**
 * Read-only transcription source: `packages/server/src/routes/auth.ts`
 * (rotate-token), `routes/me.ts` (token mint / project CRUD, ~line 135),
 * `routes/context.ts` (`checkProjectAccess`, confinement 403 at ~line
 * 218), and `http.ts`'s `restrictedTokenDenied` (read-only-token gate) —
 * all read-only, never imported.
 *
 * Every token/project this suite mints is a THROWAWAY, never the shared
 * `NOVAMEM_TEST_TOKEN` — rotating that would break every other suite that
 * runs after this one. Cleanup is best-effort in `afterAll` and never
 * fails the suite; failures are logged.
 */

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

const mintedTokenHashes: string[] = [];
const createdProjectIds: string[] = [];
const forgetIds: string[] = [];

afterAll(async () => {
  for (const id of forgetIds) {
    try {
      await api("/v1/forget", { body: { id } });
    } catch (e) {
      console.warn(`cleanup: forget ${id} failed`, e);
    }
  }
  for (const hash of mintedTokenHashes) {
    try {
      const r = await adminCookieApi(`/v1/me/tokens/${hash}`, { method: "DELETE" });
      if (r.status !== 200) console.warn(`cleanup: delete token ${hash} → ${r.status}`, r.body);
    } catch (e) {
      console.warn(`cleanup: delete token ${hash} failed`, e);
    }
  }
  for (const id of createdProjectIds) {
    try {
      const r = await adminCookieApi(`/v1/me/projects/${id}`, { method: "DELETE" });
      if (r.status !== 200) console.warn(`cleanup: delete project ${id} → ${r.status}`, r.body);
    } catch (e) {
      console.warn(`cleanup: delete project ${id} failed`, e);
    }
  }
});

describe("auth gates", () => {
  it("data plane without a token is 401 (unless mode=none)", async () => {
    const r = await api("/v1/recent", { body: { limit: 1 }, token: "" });
    expect(r.status).toBe(env.authMode === "none" ? 200 : 401);
  });

  it("garbage bearer is 401 with error body", async () => {
    const r = await api<unknown>("/v1/recent", { body: { limit: 1 }, token: "nm_bogus" });
    if (env.authMode === "none") return;
    expect(r.status).toBe(401);
    ErrorBody.parse(r.body);
  });

  it("an unauthenticated caller cannot reach /v1/admin/metrics", async () => {
    // Two legitimate answers, depending on the target's
    // NOVAMEM_ADMIN_DASHBOARD: 404 "admin disabled" (the surface gate
    // fires before `requireAdmin`, so it answers the same to everyone)
    // or 401 (surface on, credentials missing). Never a 2xx.
    //
    // This used to send `env.testToken` and assert the same thing — which
    // silently depended on that token NOT belonging to an admin. It does
    // on some targets and doesn't on others, and the assertion passed
    // either way only because the bench oracle had metrics switched off.
    // The genuine "authenticated non-admin is denied" case now lives in
    // 60-admin, which provisions a real non-admin bearer to make it with.
    const r = await api<{ error: string }>("/v1/admin/metrics", { token: "" });
    expect([401, 404]).toContain(r.status);
    ErrorBody.parse(r.body);
  });
});

describe.skipIf(env.authMode !== "user")("rotate-token (user mode)", () => {
  // A THROWAWAY token, minted fresh via the admin cookie, is rotated —
  // never the shared NOVAMEM_TEST_TOKEN every other suite depends on.
  it("mints a throwaway, rotates it, and old dies while new works", async () => {
    const mint = await adminCookieApi<{ token: string; userId: string; createdAt: string }>(
      "/v1/me/tokens",
      { body: { label: `conf-rotate-${ns()}` } },
    );
    expect(mint.status).toBe(201);
    const original = mint.body.token;
    expect(original).toMatch(/^nm_/);
    mintedTokenHashes.push(sha256Hex(original));

    // Sanity: the freshly minted token can reach the data plane before
    // rotation.
    const preCheck = await api("/v1/recent", { body: { limit: 1 }, token: original });
    expect(preCheck.status).toBe(200);

    // POST /v1/auth/rotate-token — routes/auth.ts: presents the current
    // bearer via Authorization, gets a new plaintext back, 201, old one
    // revoked atomically in the same transaction.
    const rotate = await api<{ token: string; userId: string; createdAt: string; warning: string }>(
      "/v1/auth/rotate-token",
      { method: "POST", token: original },
    );
    expect(rotate.status).toBe(201);
    expect(rotate.body.token).toMatch(/^nm_/);
    expect(rotate.body.token).not.toBe(original);
    expect(rotate.body.warning).toBeTruthy();
    const rotated = rotate.body.token;

    // Old token is dead: any data-plane call now 401s.
    const oldDead = await api("/v1/recent", { body: { limit: 1 }, token: original });
    expect(oldDead.status).toBe(401);

    // New token works.
    const newWorks = await api("/v1/recent", { body: { limit: 1 }, token: rotated });
    expect(newWorks.status).toBe(200);

    // Track the ROTATED token's hash for cleanup (the original's hash
    // is now a dead row, but deleting by its hash is a no-op 404 — track
    // the live one instead so cleanup actually removes the row).
    mintedTokenHashes.pop();
    mintedTokenHashes.push(sha256Hex(rotated));
  });

  it("rotate-token requires a bearer; unauthenticated is 401", async () => {
    const r = await api<unknown>("/v1/auth/rotate-token", { method: "POST", token: "" });
    expect(r.status).toBe(401);
  });
});

describe.skipIf(env.authMode !== "user" || !hasAdminIdentity)(
  "project-confined + read-only tokens (user mode)",
  () => {
    it("confined token: cross-project write is 403, own-project write succeeds", async () => {
      const home = await adminCookieApi<{ id: string; name: string }>("/v1/me/projects", {
        body: { name: `conf-home-${ns()}` },
      });
      expect(home.status).toBe(201);
      createdProjectIds.push(home.body.id);

      const away = await adminCookieApi<{ id: string; name: string }>("/v1/me/projects", {
        body: { name: `conf-away-${ns()}` },
      });
      expect(away.status).toBe(201);
      createdProjectIds.push(away.body.id);

      const mint = await adminCookieApi<{ token: string }>("/v1/me/tokens", {
        body: { label: `conf-confined-${ns()}`, project: home.body.id },
      });
      expect(mint.status).toBe(201);
      const confined = mint.body.token;
      mintedTokenHashes.push(sha256Hex(confined));

      // Explicit foreign project — routes/context.ts checkProjectAccess:
      // 403 "token is confined to its project".
      const crossProject = await api<{ error: string }>("/v1/remember", {
        token: confined,
        body: { content: `confined-cross-project probe ${ns()}`, project: away.body.id },
      });
      expect(crossProject.status).toBe(403);
      ErrorBody.parse(crossProject.body);
      expect(crossProject.body.error).toBe("token is confined to its project");

      // Own (confined) project — succeeds; body.project gets rewritten to
      // the token's project regardless, but passing it explicitly here
      // exercises the same code path deterministically.
      const ownProject = await api<{ id: string | null }>("/v1/remember", {
        token: confined,
        body: {
          content: `confined-own-project probe, namespace ${ns()}, home project`,
          project: home.body.id,
        },
      });
      expect(ownProject.status).toBe(201);
      if (ownProject.body.id) forgetIds.push(ownProject.body.id);

      // No project specified at all — silently forced into the token's
      // own project (checkProjectAccess rewrites body.project), not a 403.
      const noProject = await api<{ id: string | null }>("/v1/remember", {
        token: confined,
        body: { content: `confined-default-project probe, namespace ${ns()}, no project set` },
      });
      expect(noProject.status).toBe(201);
      if (noProject.body.id) forgetIds.push(noProject.body.id);
    });

    it("read-only token: write POST rejected, read POST allowed", async () => {
      const mint = await adminCookieApi<{ token: string }>("/v1/me/tokens", {
        body: { label: `conf-readonly-${ns()}`, scope: "read_only" },
      });
      expect(mint.status).toBe(201);
      const readOnly = mint.body.token;
      mintedTokenHashes.push(sha256Hex(readOnly));

      // http.ts restrictedTokenDenied: scope read_only + non-GET path not
      // in the READ_POSTS allowlist → 403 "read-only token".
      const write = await api<{ error: string }>("/v1/remember", {
        token: readOnly,
        body: { content: `read-only-token write probe ${ns()}` },
      });
      expect(write.status).toBe(403);
      ErrorBody.parse(write.body);
      expect(write.body.error).toBe("read-only token");

      // /v1/search is in the READ_POSTS allowlist — passes despite being
      // a POST.
      const read = await api("/v1/search", {
        token: readOnly,
        body: { query: "read-only token conformance probe", k: 1 },
      });
      expect(read.status).toBe(200);
    });

    it("restricted token cannot mutate /v1/me/tokens (self-escalation guard)", async () => {
      const mint = await adminCookieApi<{ token: string }>("/v1/me/tokens", {
        body: { label: `conf-restricted-${ns()}`, scope: "read_only" },
      });
      expect(mint.status).toBe(201);
      const restricted = mint.body.token;
      mintedTokenHashes.push(sha256Hex(restricted));

      // http.ts restrictedTokenDenied: /v1/me/tokens mutation is denied
      // outright for a restricted bearer — minting is how it would
      // otherwise escalate itself to an unrestricted token.
      const mintAttempt = await api<{ error: string }>("/v1/me/tokens", {
        token: restricted,
        body: { label: "should-be-denied" },
      });
      expect(mintAttempt.status).toBe(403);
      expect(mintAttempt.body.error).toBe("restricted token");
    });

    it("restricted token CAN still self-rotate, preserving its restriction", async () => {
      // http.ts special-cases `/v1/auth/rotate-token` to bypass the
      // dashUser/restrictedTokenDenied hook entirely — the route handler
      // authenticates itself by trying to rotate the presented bearer
      // (see http.ts: "the CLI rotate-token path is reached without
      // prior auth"). rotateUserToken() then copies the old row's
      // scope/projectId onto the new row verbatim, so a restricted
      // token rotating itself does NOT escalate to a full one.
      const mint = await adminCookieApi<{ token: string }>("/v1/me/tokens", {
        body: { label: `conf-rotate-readonly-${ns()}`, scope: "read_only" },
      });
      expect(mint.status).toBe(201);
      const original = mint.body.token;
      mintedTokenHashes.push(sha256Hex(original));

      const rotate = await api<{ token: string }>("/v1/auth/rotate-token", {
        method: "POST",
        token: original,
      });
      expect(rotate.status).toBe(201);
      const rotated = rotate.body.token;
      mintedTokenHashes.pop();
      mintedTokenHashes.push(sha256Hex(rotated));

      // The rotated token is still read-only: a write is still 403.
      const write = await api<{ error: string }>("/v1/remember", {
        token: rotated,
        body: { content: `rotated-readonly write probe ${ns()}` },
      });
      expect(write.status).toBe(403);
      expect(write.body.error).toBe("read-only token");
    });
  },
);
