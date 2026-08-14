import { createHash } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";
import { adminCookieApi, api, ns } from "../src/client.js";
import { env, hasAdminIdentity } from "../src/env.js";
import {
  ActiveProjectResponse,
  ChangesResponse,
  ErrorBody,
  ExportResponse,
  ImportResponse,
  MembersResponse,
  MetricsHistoryResponse,
  MintTokenResponse,
  OnboardingResponse,
  ProjectResponse,
  TodayResponse,
  TokenListResponse,
  UsageResponse,
} from "../src/schemas.js";

/**
 * Read-only transcription source: `packages/server/src/routes/me.ts`
 * (every /v1/me/* handler), `routes/context.ts` (`requireDashUser`,
 * `resolveProjectRef`, `checkProjectAccess`), `routes/schemas.ts`
 * (Mint/CreateProject/ActiveProject/AddMember/MeChanges/MeExport/MeImport
 * bodies), `warm-store/index.ts` (`createProject`, `exportEntries`,
 * `listChanges`, `getUserQuota`, `listProjectMembers`, `listRecentActivity`),
 * and `engine/index.ts` (`remember`, `deleteProject`, `logChange`) — all
 * read-only, never imported.
 *
 * NOTE ON SOURCE: this worktree's checked-out `packages/server/src/routes/
 * me.ts` predates the changelog/export/import/usage endpoints (they land
 * on `feat/export-import`, `feat/change-log`, `feat/user-quotas`, not yet
 * merged to this branch's base). The live oracle already serves all of
 * them (confirmed via `GET /openapi.json`, matching `coverage.ts`'s
 * `50-me` manifest), so this suite's oracle knowledge for those four
 * routes was transcribed from `git show feat/export-import:packages/
 * server/src/routes/me.ts` (and the corresponding `warm-store`/`engine`
 * files on that branch) — still read-only, never imported, just a
 * different ref of the same file this task already owns.
 *
 * Credentials: `/v1/me/*` accepts EITHER a Better-Auth session cookie
 * (`adminCookieApi`) OR a full-scope `nm_…` bearer (`env.testToken`, via
 * plain `api()`) — `http.ts`'s `wantsDashUser` allowlist resolves an
 * `nm_` bearer into `req.dashUser` for `/v1/me/*` same as it does for
 * `/v1/auth/*` and `/v1/admin/*`. Verified directly against the live
 * oracle (`curl` with each credential against `/v1/me/today` etc., both
 * 200) before writing this suite. Both credential paths are exercised
 * below rather than assumed.
 *
 * Active-project semantics (source-verified, corrects a naive "it's just
 * a UI pointer" assumption): `checkProjectAccess` (context.ts) DOES
 * consult the active-project pointer for unconfined bearers. For
 * `/v1/remember` (`unionWithActive: false`), when the request body has
 * no `project`/`includeProjects` at all, an active project is
 * substituted directly as `body.project` — so a plain `remember()` call
 * silently lands in the active project once one is set. This suite
 * exercises exactly that: sets active-project, then remembers with NO
 * explicit `project`, and confirms the entry landed there.
 *
 * Every project/token/memory this suite creates is a THROWAWAY under a
 * unique namespace; cleanup is best-effort in `afterAll` (log-and-continue,
 * never fails the suite). Deleting the project at the end removes its
 * memory entries too (`engine.deleteProject`), so entries written INTO the
 * project don't need individual `/v1/forget` cleanup — only entries
 * written outside any project are tracked separately.
 */

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

const createdProjectIds: string[] = [];
const mintedTokenHashes: string[] = [];
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
      if (r.status !== 200 && r.status !== 404) {
        console.warn(`cleanup: delete token ${hash} → ${r.status}`, r.body);
      }
    } catch (e) {
      console.warn(`cleanup: delete token ${hash} failed`, e);
    }
  }
  for (const id of createdProjectIds) {
    try {
      // Always clear active-project before deleting, in case a test
      // failed mid-lifecycle and left it pointed at a project we're
      // about to remove.
      await adminCookieApi("/v1/me/active-project", { method: "DELETE" });
      const r = await adminCookieApi(`/v1/me/projects/${id}`, { method: "DELETE" });
      if (r.status !== 200 && r.status !== 404) {
        console.warn(`cleanup: delete project ${id} → ${r.status}`, r.body);
      }
    } catch (e) {
      console.warn(`cleanup: delete project ${id} failed`, e);
    }
  }
});

describe.skipIf(env.authMode !== "user" || !hasAdminIdentity)(
  "/v1/me lifecycle (user mode)",
  () => {
    it("unauthenticated GET /v1/me/today is 401", async () => {
      const r = await api<{ error: string }>("/v1/me/today", { token: "" });
      expect(r.status).toBe(401);
      ErrorBody.parse(r.body);
      expect(r.body.error).toBe("unauthorized");
    });

    it("full lifecycle: project → active-project → remember → today/changes/metrics/onboarding/usage/export → members → tokens → clear/delete", async () => {
      const NS = ns();

      // ── 0. One user-global entry, BEFORE an active project exists ──
      // /v1/me/onboarding derives `remembered` from recent(user, {k:1})
      // with no project scope — on both servers — and once an active
      // project is set, unscoped writes land in that project. Long-lived
      // oracle accounts already had user-global rows, which masked this;
      // a fresh account does not. Write one while writes are still
      // user-global so step 8 tests the endpoint, not account history.
      const globalWrite = await api("/v1/remember", {
        body: { content: `onboarding probe entry ${ns()} written user-global` },
      });
      expect([200, 201]).toContain(globalWrite.status);

      // ── 1. Create a project (adminCookieApi = session cookie) ──────
      const create = await adminCookieApi<{ id: string; name: string; ownerUserId: string }>(
        "/v1/me/projects",
        { body: { name: `conf-me-${NS}` } },
      );
      expect(create.status).toBe(201);
      ProjectResponse.parse(create.body);
      const projectId = create.body.id;
      const ownerUserId = create.body.ownerUserId;
      createdProjectIds.push(projectId);

      // ── 2. Set active-project ───────────────────────────────────────
      const setActive = await adminCookieApi<{ active: { id: string } }>("/v1/me/active-project", {
        method: "PUT",
        body: { project: projectId },
      });
      expect(setActive.status).toBe(200);
      expect(setActive.body.active.id).toBe(projectId);

      // ── 3. GET active-project confirms it, with the full-scope bearer
      //      too (not just the cookie that set it — same user account) ──
      const getActiveCookie = await adminCookieApi<{ active: { id: string; name: string } | null }>(
        "/v1/me/active-project",
      );
      expect(getActiveCookie.status).toBe(200);
      ActiveProjectResponse.parse(getActiveCookie.body);
      expect(getActiveCookie.body.active?.id).toBe(projectId);

      const getActiveBearer = await api<{ active: { id: string } | null }>("/v1/me/active-project");
      expect(getActiveBearer.status).toBe(200);
      expect(getActiveBearer.body.active?.id).toBe(projectId);

      // ── 4. Remember WITHOUT an explicit project — checkProjectAccess
      //      (unionWithActive: false for writes) substitutes the active
      //      project directly into body.project. ─────────────────────
      const content = `conf-me lifecycle probe ${NS}: the espresso machine needs descaling monthly`;
      // Captured just before the write so the /v1/me/changes query below
      // can scope to `since` — the changelog defaults to oldest-first
      // (page 1 of up to 200 rows), so on an oracle with plenty of prior
      // changelog history a bare query would never reach our new row.
      const sinceTs = new Date().toISOString();
      const remember = await api<{ id: string | null }>("/v1/remember", {
        body: { content, namespace: NS },
      });
      expect(remember.status).toBe(201);
      expect(remember.body.id).not.toBeNull();
      const entryId = remember.body.id!;

      // Confirm it actually landed in the active project (not the
      // user-global scope) by reading it back scoped to that project.
      const recentInProject = await api<{ results: Array<{ id: string; project?: string | null }> }>(
        "/v1/recent",
        { body: { project: projectId, k: 10 } },
      );
      expect(recentInProject.status).toBe(200);
      expect(recentInProject.body.results.some((r) => r.id === entryId)).toBe(true);

      // ── 5. /v1/me/today shows the remember as recent activity ──────
      const today = await api<{ events: Array<{ kind: string; text: string }> }>("/v1/me/today");
      expect(today.status).toBe(200);
      TodayResponse.parse(today.body);
      expect(
        today.body.events.some((e) => e.kind === "remember" && e.text.includes(`conf-me lifecycle probe ${NS}`)),
      ).toBe(true);

      // ── 6. /v1/me/changes shows the "created" change — recordChanges
      //      is fire-and-forget, so poll briefly rather than assume
      //      synchronous visibility. ─────────────────────────────────
      let sawCreated = false;
      for (let attempt = 0; attempt < 10 && !sawCreated; attempt++) {
        const changes = await api<{ changes: Array<{ entryId: string; change: string }> }>(
          `/v1/me/changes?since=${encodeURIComponent(sinceTs)}`,
          { method: "GET" },
        );
        expect(changes.status).toBe(200);
        ChangesResponse.parse(changes.body);
        sawCreated = changes.body.changes.some((c) => c.entryId === entryId && c.change === "created");
        if (!sawCreated) await new Promise((res) => setTimeout(res, 300));
      }
      expect(sawCreated, "expected a 'created' /v1/me/changes row for the remembered entry").toBe(true);

      // ── 7. Metrics + metrics/history respond with sane shapes ──────
      const metrics = await api<Record<string, unknown>>("/v1/me/metrics");
      expect(metrics.status).toBe(200);
      expect(typeof metrics.body).toBe("object");

      const history = await api<{ hours: number; samples: unknown[] }>("/v1/me/metrics/history?hours=1");
      expect(history.status).toBe(200);
      MetricsHistoryResponse.parse(history.body);
      expect(history.body.hours).toBe(1);

      // ── 8. Onboarding responds, reflecting a USER-GLOBAL remember ──
      // /v1/me/onboarding derives `remembered` from recent(user, {k:1})
      // with NO project scope — on both servers — so the project-scoped
      // write above does not set it. Long-lived accounts on the oracle
      // happen to have user-global rows, which masked this; a fresh
      // account does not. Write one explicitly so the assertion tests
      // the endpoint rather than the account's history.
      const onboarding = await api<{ remembered: boolean; userExists: boolean }>("/v1/me/onboarding");
      expect(onboarding.status).toBe(200);
      OnboardingResponse.parse(onboarding.body);
      expect(onboarding.body.userExists).toBe(true);
      expect(onboarding.body.remembered).toBe(true);

      // ── 9. Usage: entry count + effective quota ─────────────────────
      const usage = await api<{ entries: number }>("/v1/me/usage");
      expect(usage.status).toBe(200);
      UsageResponse.parse(usage.body);
      expect(usage.body.entries).toBeGreaterThan(0);

      // ── 10. Export: keyset-paged dump includes our entry ────────────
      const exp = await api<{ entries: Array<{ id: string }>; nextAfterId: string | null }>(
        "/v1/me/export?limit=1000",
      );
      expect(exp.status).toBe(200);
      ExportResponse.parse(exp.body);
      expect(exp.body.entries.some((e) => e.id === entryId)).toBe(true);

      // ── 11. Import: round-trip one entry back in, scoped to the same
      //       project so project-delete cleans it up too. Ids are not
      //       preserved (deployment-local ULIDs) — verify via count. ──
      const importContent = `conf-me import probe ${NS}: the router firmware update is scheduled for Sunday`;
      const before = await api<{ entries: number }>("/v1/me/usage");
      const imp = await api<{ imported: number; deduplicated: number; failed: unknown[] }>(
        "/v1/me/import",
        { body: { entries: [{ content: importContent, namespace: NS, project: projectId }] } },
      );
      expect(imp.status).toBe(201);
      ImportResponse.parse(imp.body);
      expect(imp.body.imported).toBe(1);
      expect(imp.body.failed).toEqual([]);
      const after = await api<{ entries: number }>("/v1/me/usage");
      expect(after.body.entries).toBe(before.body.entries + 1);

      // ── 12. Members: single-bench-user failure contracts ────────────
      const members = await api<{ members: Array<{ userId: string; role: string }> }>(
        `/v1/me/projects/${projectId}/members`,
      );
      expect(members.status).toBe(200);
      MembersResponse.parse(members.body);
      expect(members.body.members.some((m) => m.userId === ownerUserId && m.role === "owner")).toBe(
        true,
      );

      // Unknown email → 404 "unknown user" (the exact single-user-bench
      // failure contract: no second dashboard user exists to invite).
      const addUnknown = await api<{ error: string }>(`/v1/me/projects/${projectId}/members`, {
        body: { username: `nobody-${NS}@example.invalid` },
      });
      expect(addUnknown.status).toBe(404);
      ErrorBody.parse(addUnknown.body);
      expect(addUnknown.body.error).toBe("unknown user");

      // The bench's only real user is the owner (env.adminEmail) — adding
      // them by email resolves to a real user but they're already a
      // member (auto-added as owner on project create): 409.
      if (env.adminEmail) {
        const addSelf = await api<{ error: string }>(`/v1/me/projects/${projectId}/members`, {
          body: { username: env.adminEmail },
        });
        expect(addSelf.status).toBe(409);
        ErrorBody.parse(addSelf.body);
        expect(addSelf.body.error).toBe("user is already a member");
      }

      // Owner cannot remove themselves via the member-removal path —
      // 400, distinct from delete-project.
      const removeOwner = await api<{ error: string }>(
        `/v1/me/projects/${projectId}/members/${ownerUserId}`,
        { method: "DELETE" },
      );
      expect(removeOwner.status).toBe(400);
      ErrorBody.parse(removeOwner.body);
      expect(removeOwner.body.error).toBe("owner cannot leave; delete the project instead");

      // ── 13. Token create → list → delete ────────────────────────────
      const mint = await adminCookieApi<{ token: string; userId: string; scope: string }>(
        "/v1/me/tokens",
        { body: { label: `conf-me-token-${NS}` } },
      );
      expect(mint.status).toBe(201);
      MintTokenResponse.parse(mint.body);
      const plaintext = mint.body.token;
      expect(plaintext).toMatch(/^nm_/);
      const hash = sha256Hex(plaintext);
      mintedTokenHashes.push(hash);

      const list = await api<{ tokens: Array<{ tokenHash: string }> }>("/v1/me/tokens");
      expect(list.status).toBe(200);
      TokenListResponse.parse(list.body);
      expect(list.body.tokens.some((t) => t.tokenHash === hash)).toBe(true);

      const del = await api<{ deleted: boolean }>(`/v1/me/tokens/${hash}`, { method: "DELETE" });
      expect(del.status).toBe(200);
      expect(del.body.deleted).toBe(true);
      mintedTokenHashes.pop();

      // Deleting an already-deleted token hash is 404.
      const delAgain = await api<{ error: string }>(`/v1/me/tokens/${hash}`, { method: "DELETE" });
      expect(delAgain.status).toBe(404);
      ErrorBody.parse(delAgain.body);
      expect(delAgain.body.error).toBe("token not found");

      // ── 14. Clear active-project ─────────────────────────────────────
      const clearActive = await api("/v1/me/active-project", { method: "DELETE" });
      expect(clearActive.status).toBe(204);

      const getActiveAfterClear = await api<{ active: null }>("/v1/me/active-project");
      expect(getActiveAfterClear.status).toBe(200);
      expect(getActiveAfterClear.body.active).toBeNull();

      // ── 15. Delete project (owner only) — removes its entries too ───
      const del2 = await adminCookieApi<{ deleted: boolean; entriesRemoved: number }>(
        `/v1/me/projects/${projectId}`,
        { method: "DELETE" },
      );
      expect(del2.status).toBe(200);
      expect(del2.body.deleted).toBe(true);
      expect(del2.body.entriesRemoved).toBeGreaterThanOrEqual(2);
      createdProjectIds.splice(createdProjectIds.indexOf(projectId), 1);

      // Deleting an already-deleted project is 404 "unknown project".
      const del2Again = await adminCookieApi<{ error: string }>(`/v1/me/projects/${projectId}`, {
        method: "DELETE",
      });
      expect(del2Again.status).toBe(404);
      ErrorBody.parse(del2Again.body);
      expect(del2Again.body.error).toBe("unknown project");
    }, 60_000);

    it("GET /v1/me/projects lists projects for both cookie and bearer identities", async () => {
      const viaCookie = await adminCookieApi<{ projects: unknown[] }>("/v1/me/projects");
      expect(viaCookie.status).toBe(200);
      const viaBearer = await api<{ projects: unknown[] }>("/v1/me/projects");
      expect(viaBearer.status).toBe(200);
    });
  },
);
