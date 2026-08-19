import type { z } from "zod";
import { afterAll, describe, expect, it } from "vitest";
import { adminCookieApi, api, ns } from "../src/client.js";
import { env, hasAdminIdentity } from "../src/env.js";
import {
  AdminAuditLogResponse,
  AdminCreateUserResponse,
  AdminDeleteUserResponse,
  AdminHealthDeepResponse,
  AdminQuotaResponse,
  AdminRevokeResponse,
  AdminUsersResponse,
  ErrorBody,
  MintTokenResponse,
} from "../src/schemas.js";

/**
 * Read-only transcription source: `packages/server/src/routes/admin.ts`
 * (tokens/revoke, users CRUD, audit-log, metrics, metrics/prom),
 * `http.ts` (`/v1/admin/health/deep`, `adminAuth`), and
 * `routes/context.ts` (`requireAdmin`) — all read-only, never imported.
 *
 * This worktree's checked-out `admin.ts` predates `PUT
 * /v1/admin/users/{id}/quota` (it lands on `feat/user-quotas`, not yet
 * merged to this branch's base — same situation task-7 hit for
 * `/v1/me/*`). `coverage.ts`'s `60-admin` manifest was seeded from the
 * live oracle's `/openapi.json` and does list it, and the live oracle
 * does serve it (confirmed via curl) — so its exact shape here was
 * transcribed from `git show origin/feat/user-quotas:packages/server/
 * src/routes/{admin,schemas}.ts`, still read-only, never imported.
 *
 * Two load-bearing corrections to the brief, both verified against the
 * live oracle (not assumed from source alone):
 *
 * 1. **`NOVAMEM_TEST_TOKEN` is NOT a useful "denied" credential for this
 *    suite.** On this bench it is literally the bootstrap admin's own
 *    bearer — `http.ts`'s `wantsDashUser` allowlist resolves an `nm_`
 *    bearer into `req.dashUser` for `/v1/admin/*` same as it does for
 *    `/v1/me/*` (task-7), and this particular token belongs to the
 *    admin account, so it sails through `requireAdmin` with a 200/201,
 *    not a 401/403. Verified directly: `curl -H "Authorization: Bearer
 *    $NOVAMEM_TEST_TOKEN" $URL/v1/admin/users` → 200 with the full user
 *    list. A genuine "denied" test needs a real non-admin credential, so
 *    this suite provisions a throwaway non-admin user (+ bearer) via
 *    `POST /v1/admin/users` itself and uses THAT token for every
 *    denied-caller assertion below; it is deleted in the same test.
 *
 * 2. **`POST /v1/admin/tokens/revoke` does not write an audit-log
 *    entry.** Source confirms it (the handler calls
 *    `ctx.warm.revokeUserToken` directly, no `ctx.audit(...)` call —
 *    unlike `admin.user.create/delete/quota`, which do). Verified
 *    empirically too: minted a throwaway token, revoked it, polled
 *    `/v1/admin/audit-log` immediately after — no new row appeared, on
 *    a bench serving audit-log entries in the same call. So this suite
 *    exercises the revoke endpoint's own contract (idempotent
 *    `{revoked: boolean}`) but proves the audit-log claim via the
 *    `admin.user.create`/`admin.user.quota` events that the throwaway
 *    user's own provisioning already produces — real, source-confirmed
 *    audited actions — rather than asserting something false about
 *    revoke.
 *
 * `/v1/admin/metrics` and `/v1/admin/metrics/prom` are fully disabled
 * on this oracle (`ctx.adminDashboard`/`ctx.metrics` unset server-side):
 * both 404 `{"error":"admin disabled"}` for EVERY caller, admin cookie
 * included — that gate runs before `requireAdmin`. Verified live,
 * repeatedly, with both credentials. The suite asserts the oracle's
 * actual behavior rather than the brief's `text/plain` assumption.
 *
 * Every user/token this suite provisions is a throwaway created inside
 * a single test and deleted before the test ends (or in `afterAll` as a
 * backstop) — never the shared `NOVAMEM_TEST_TOKEN`/admin account.
 */

const createdUserIds: string[] = [];

afterAll(async () => {
  for (const id of createdUserIds) {
    try {
      const r = await adminCookieApi(`/v1/admin/users/${id}`, {
        method: "DELETE",
      });
      if (r.status !== 200 && r.status !== 404) {
        console.warn(
          `cleanup: delete admin-provisioned user ${id} → ${r.status}`,
          r.body
        );
      }
    } catch (e) {
      console.warn(`cleanup: delete admin-provisioned user ${id} failed`, e);
    }
  }
});

describe.skipIf(env.authMode !== "user" || !hasAdminIdentity)(
  "admin plane (user mode)",
  () => {
    it("unauthenticated is 401 across every requireAdmin-gated /v1/admin/* route", async () => {
      const noAuth = { token: "" };
      const getUsers = await api<z.infer<typeof ErrorBody>>(
        "/v1/admin/users",
        noAuth
      );
      expect(getUsers.status).toBe(401);
      ErrorBody.parse(getUsers.body);
      expect(getUsers.body.error).toBe("unauthorized");

      const auditLog = await api<z.infer<typeof ErrorBody>>(
        "/v1/admin/audit-log",
        noAuth
      );
      expect(auditLog.status).toBe(401);
      expect(auditLog.body.error).toBe("unauthorized");

      const healthDeep = await api<z.infer<typeof ErrorBody>>(
        "/v1/admin/health/deep",
        noAuth
      );
      expect(healthDeep.status).toBe(401);
      expect(healthDeep.body.error).toBe("unauthorized");

      const revoke = await api<z.infer<typeof ErrorBody>>(
        "/v1/admin/tokens/revoke",
        {
          ...noAuth,
          method: "POST",
          body: { token: "nm_bogus" },
        }
      );
      expect(revoke.status).toBe(401);
      expect(revoke.body.error).toBe("unauthorized");

      const createUser = await api<z.infer<typeof ErrorBody>>(
        "/v1/admin/users",
        {
          ...noAuth,
          body: { email: "unauth@example.com", password: "does-not-matter" },
        }
      );
      expect(createUser.status).toBe(401);
      expect(createUser.body.error).toBe("unauthorized");

      const deleteUser = await api<z.infer<typeof ErrorBody>>(
        "/v1/admin/users/bogus-id",
        {
          ...noAuth,
          method: "DELETE",
        }
      );
      expect(deleteUser.status).toBe(401);
      expect(deleteUser.body.error).toBe("unauthorized");

      const putQuota = await api<z.infer<typeof ErrorBody>>(
        "/v1/admin/users/bogus-id/quota",
        {
          ...noAuth,
          method: "PUT",
          body: {},
        }
      );
      expect(putQuota.status).toBe(401);
      expect(putQuota.body.error).toBe("unauthorized");
    });

    it("/v1/admin/metrics and /v1/admin/metrics/prom follow the dashboard master switch", async () => {
      // `admin.ts` gates both routes on `ctx.adminDashboard`/`ctx.metrics`
      // BEFORE `requireAdmin`, so with the surface off they are 404 "admin
      // disabled" for EVERY caller — admin cookie included. With it on they
      // are ordinary admin routes: 401 unauthenticated, 200 for an admin.
      //
      // This test used to assert only the disabled branch ("on this
      // oracle"), which made it a configuration transcript rather than a
      // contract — it went red the moment it met a target with the
      // dashboard switched on. `dashboardEnabled` is probed rather than
      // read from env so it cannot drift from the target.
      const probe = await api("/admin", { token: "" });
      const enabled = probe.status === 200;

      for (const path of [
        "/v1/admin/metrics",
        "/v1/admin/metrics/prom",
      ] as const) {
        const unauth = await api<z.infer<typeof ErrorBody>>(path, {
          token: "",
        });
        ErrorBody.parse(unauth.body);
        const cookie = await adminCookieApi<unknown>(path);

        if (!enabled) {
          expect(unauth.status).toBe(404);
          expect(unauth.body.error).toBe("admin disabled");
          expect(cookie.status).toBe(404);
          expect((cookie.body as z.infer<typeof ErrorBody>).error).toBe(
            "admin disabled"
          );
          continue;
        }

        expect(unauth.status).toBe(401);
        expect(unauth.body.error).toBe("unauthorized");
        expect(cookie.status).toBe(200);
        const ct = cookie.headers.get("content-type") ?? "";
        if (path.endsWith("/prom")) {
          expect(ct).toMatch(/^text\/plain/);
          expect(typeof cookie.body).toBe("string");
        } else {
          expect(ct).toMatch(/^application\/json/);
          expect(typeof cookie.body).toBe("object");
        }
      }
    });

    it("GET /v1/admin/users (admin cookie): bootstrap admin appears with an admin role", async () => {
      const r = await adminCookieApi<z.infer<typeof AdminUsersResponse>>(
        "/v1/admin/users"
      );
      expect(r.status).toBe(200);
      AdminUsersResponse.parse(r.body);
      const bootstrap = r.body.users.find((u) => u.email === env.adminEmail);
      expect(bootstrap).toBeTruthy();
      expect(bootstrap!.role).toBe("admin");
    });

    it("full lifecycle: provision throwaway non-admin user → prove non-admin denial → quota → audit-log → tokens/revoke → delete", async () => {
      const NS = ns();
      const email = `conf-60admin-${NS}@bench.local`;

      // ── 1. Provision a throwaway non-admin user + bearer (admin cookie) ──
      const create = await adminCookieApi<
        z.infer<typeof AdminCreateUserResponse>
      >("/v1/admin/users", {
        body: {
          email,
          password: "conformance-throwaway-pw-1",
          tokenLabel: `conf-60admin-${NS}`,
        },
      });
      expect(create.status).toBe(201);
      AdminCreateUserResponse.parse(create.body);
      const userId = create.body.userId;
      const nonAdminToken = create.body.token;
      expect(nonAdminToken).toBeTruthy();
      createdUserIds.push(userId);

      // ── 2. That throwaway (non-admin, authenticated) bearer is denied on
      //      every requireAdmin-gated route — 403 "admin only", since it DOES
      //      resolve to a dashUser (just not an admin one). /v1/admin/health/
      //      deep is the one exception: it's gated by the boolean `adminAuth`
      //      helper (not `requireAdmin`), which can't distinguish "no
      //      credentials" from "credentials, wrong role" — both are 401.
      const deniedUsers = await api<z.infer<typeof ErrorBody>>(
        "/v1/admin/users",
        { token: nonAdminToken }
      );
      expect(deniedUsers.status).toBe(403);
      ErrorBody.parse(deniedUsers.body);
      expect(deniedUsers.body.error).toBe("admin only");

      const deniedAudit = await api<z.infer<typeof ErrorBody>>(
        "/v1/admin/audit-log",
        {
          token: nonAdminToken,
        }
      );
      expect(deniedAudit.status).toBe(403);
      expect(deniedAudit.body.error).toBe("admin only");

      const deniedRevoke = await api<z.infer<typeof ErrorBody>>(
        "/v1/admin/tokens/revoke",
        {
          method: "POST",
          token: nonAdminToken,
          body: { token: "nm_bogus" },
        }
      );
      expect(deniedRevoke.status).toBe(403);
      expect(deniedRevoke.body.error).toBe("admin only");

      const deniedCreate = await api<z.infer<typeof ErrorBody>>(
        "/v1/admin/users",
        {
          token: nonAdminToken,
          body: {
            email: "should-not-be-created@example.com",
            password: "irrelevant",
          },
        }
      );
      expect(deniedCreate.status).toBe(403);
      expect(deniedCreate.body.error).toBe("admin only");

      const deniedDelete = await api<z.infer<typeof ErrorBody>>(
        `/v1/admin/users/${userId}`,
        {
          method: "DELETE",
          token: nonAdminToken,
        }
      );
      expect(deniedDelete.status).toBe(403);
      expect(deniedDelete.body.error).toBe("admin only");

      const deniedQuota = await api<z.infer<typeof ErrorBody>>(
        `/v1/admin/users/${userId}/quota`,
        {
          method: "PUT",
          token: nonAdminToken,
          body: {},
        }
      );
      expect(deniedQuota.status).toBe(403);
      expect(deniedQuota.body.error).toBe("admin only");

      const deniedHealthDeep = await api<z.infer<typeof ErrorBody>>(
        "/v1/admin/health/deep",
        {
          token: nonAdminToken,
        }
      );
      expect(deniedHealthDeep.status).toBe(401);
      ErrorBody.parse(deniedHealthDeep.body);
      expect(deniedHealthDeep.body.error).toBe("unauthorized");

      // ── 3. Admin cookie succeeds where the non-admin bearer above was
      //      denied: quota round-trip on the throwaway user ─────────────
      const setQuota = await adminCookieApi<z.infer<typeof AdminQuotaResponse>>(
        `/v1/admin/users/${userId}/quota`,
        {
          method: "PUT",
          body: { maxEntries: 50, writesPerMinute: 5 },
        }
      );
      expect(setQuota.status).toBe(200);
      AdminQuotaResponse.parse(setQuota.body);
      expect(setQuota.body.userId).toBe(userId);
      expect(setQuota.body.quota).toEqual({
        maxEntries: 50,
        writesPerMinute: 5,
      });

      // ── 4. GET /v1/admin/health/deep (admin cookie) ───────────────────
      const health = await adminCookieApi<
        z.infer<typeof AdminHealthDeepResponse>
      >("/v1/admin/health/deep");
      expect(health.status).toBe(200);
      AdminHealthDeepResponse.parse(health.body);
      expect(health.body.ok).toBe(true);

      // ── 5. GET /v1/admin/audit-log (admin cookie): contains the
      //      admin.user.create + admin.user.quota events this test just
      //      produced. Both writes are `await`ed synchronously in the route
      //      handler before it replies (unlike /v1/me/changes' fire-and-
      //      forget append, task-7), so no polling is needed here — but a
      //      short retry is kept anyway as a cheap guard against scheduling
      //      jitter under bench load.
      let auditEntries: Array<{ action: string; target: string | null }> = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        const audit = await adminCookieApi<
          z.infer<typeof AdminAuditLogResponse>
        >("/v1/admin/audit-log?limit=50");
        expect(audit.status).toBe(200);
        AdminAuditLogResponse.parse(audit.body);
        auditEntries = audit.body.entries;
        const hasCreate = auditEntries.some(
          (e) => e.action === "admin.user.create" && e.target === userId
        );
        const hasQuota = auditEntries.some(
          (e) => e.action === "admin.user.quota" && e.target === userId
        );
        if (hasCreate && hasQuota) break;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(
        auditEntries.some(
          (e) => e.action === "admin.user.create" && e.target === userId
        )
      ).toBe(true);
      expect(
        auditEntries.some(
          (e) => e.action === "admin.user.quota" && e.target === userId
        )
      ).toBe(true);

      // ── 6. POST /v1/admin/tokens/revoke (admin cookie): mint a throwaway
      //      token via /v1/me/tokens, revoke it, verify idempotent/garbage
      //      behavior. Does NOT check for a new audit-log row — see the
      //      file-level comment: this route has no `ctx.audit` call, and a
      //      live probe confirmed no row appears after a real revoke.
      const mint = await adminCookieApi<z.infer<typeof MintTokenResponse>>(
        "/v1/me/tokens",
        {
          body: { label: `conf-60admin-revoke-${NS}` },
        }
      );
      expect(mint.status).toBe(201);
      MintTokenResponse.parse(mint.body);
      const plaintext = mint.body.token;

      const revoke = await adminCookieApi<z.infer<typeof AdminRevokeResponse>>(
        "/v1/admin/tokens/revoke",
        {
          method: "POST",
          body: { token: plaintext },
        }
      );
      expect(revoke.status).toBe(200);
      AdminRevokeResponse.parse(revoke.body);
      expect(revoke.body.revoked).toBe(true);

      const revokeAgain = await adminCookieApi<
        z.infer<typeof AdminRevokeResponse>
      >("/v1/admin/tokens/revoke", {
        method: "POST",
        body: { token: plaintext },
      });
      expect(revokeAgain.status).toBe(200);
      expect(revokeAgain.body.revoked).toBe(false);

      const revokeGarbage = await adminCookieApi<
        z.infer<typeof AdminRevokeResponse>
      >("/v1/admin/tokens/revoke", {
        method: "POST",
        body: { token: "nm_totally-bogus-never-existed" },
      });
      expect(revokeGarbage.status).toBe(200);
      expect(revokeGarbage.body.revoked).toBe(false);

      // ── 7. DELETE /v1/admin/users/{id}: dry-run, then the real delete ──
      const dryRun = await adminCookieApi<{
        dryRun: boolean;
        wouldDelete: { userId: string };
      }>(`/v1/admin/users/${userId}?dryRun=true`, { method: "DELETE" });
      expect(dryRun.status).toBe(200);
      expect(dryRun.body.dryRun).toBe(true);
      expect(dryRun.body.wouldDelete.userId).toBe(userId);

      const del = await adminCookieApi<z.infer<typeof AdminDeleteUserResponse>>(
        `/v1/admin/users/${userId}`,
        { method: "DELETE" }
      );
      expect(del.status).toBe(200);
      AdminDeleteUserResponse.parse(del.body);
      expect(del.body.deleted).toBe(true);
      // Deleted for real — drop from the afterAll backstop so cleanup
      // doesn't log a spurious 404.
      createdUserIds.splice(createdUserIds.indexOf(userId), 1);

      const deleteAgain = await adminCookieApi<z.infer<typeof ErrorBody>>(
        `/v1/admin/users/${userId}`,
        {
          method: "DELETE",
        }
      );
      expect(deleteAgain.status).toBe(404);
      ErrorBody.parse(deleteAgain.body);
      expect(deleteAgain.body.error).toBe("no such user");

      // ── 8. Self-delete guard: checked BEFORE any deletion happens, so
      //      this is safe to call for real against the admin's own account —
      //      it never actually deletes it.
      const bootstrap = await adminCookieApi<
        z.infer<typeof AdminUsersResponse>
      >("/v1/admin/users");
      AdminUsersResponse.parse(bootstrap.body);
      const adminId = bootstrap.body.users.find(
        (u) => u.email === env.adminEmail
      )!.id;
      const selfDelete = await adminCookieApi<z.infer<typeof ErrorBody>>(
        `/v1/admin/users/${adminId}`,
        {
          method: "DELETE",
        }
      );
      expect(selfDelete.status).toBe(400);
      ErrorBody.parse(selfDelete.body);
      expect(selfDelete.body.error).toBe("admins cannot delete themselves");
    });
  }
);
