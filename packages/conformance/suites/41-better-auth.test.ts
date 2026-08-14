import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminCookie,
  adminCookieApi,
  api,
  cookieApi,
  cookieHeaderFrom,
  ns,
  signIn,
  signInRaw,
} from "../src/client.js";
import { env, hasAdminIdentity } from "../src/env.js";
import { ErrorBody } from "../src/schemas.js";

/**
 * The Better Auth passthrough: all 25 paths on
 * `packages/server/src/routes/auth.ts`'s `exactPaths` allow-list, plus
 * the contract that everything else under `/api/auth/` 404s. The parity
 * audit (§9.2) found 22 of these missing on the Go server under a fully
 * green conformance run — this file closes that hole.
 *
 * Transcription sources (read-only, never imported):
 *   routes/auth.ts   — the allow-list, `guardLastAdmin`
 *                      (LAST_ADMIN_PROTECTED), `authLimiterKey`.
 *   http.ts          — the `/api/auth/` auth-hook bypass (Better Auth
 *                      owns its own auth).
 *
 * SAFETY. Every destructive call targets a THROWAWAY user this file
 * creates and deletes; the shared admin identity is only ever *read*.
 * The one exception is the LAST_ADMIN_PROTECTED probe, which by
 * definition must target the sole admin — it is a 400 that deletes
 * nothing, and it is skipped loudly when the target has more than one
 * admin (where the same call WOULD delete a real account).
 *
 * The per-account auth-failure limiter is 5 strikes / 15 minutes on
 * `signin:<email>` and `chgpw:<userId>`. Wrong-credential assertions
 * below are therefore made ONCE each, against throwaway keys.
 */

const PW = "conf-ba-throwaway-Pw1";
const PW2 = "conf-ba-throwaway-Pw2";

/** Better Auth's own "no such endpoint" is an empty-bodied 404; OUR
 *  allow-list denial is `{"error":"not found"}`. Distinguishing them is
 *  the whole point of the allow-list tests. */
const isAllowlistDenial = (body: unknown): boolean =>
  typeof body === "object" && body !== null && (body as { error?: string }).error === "not found";

interface Throwaway {
  id: string;
  email: string;
  password: string;
}

const createdUserIds: string[] = [];

let adminCk = "";
let subject: Throwaway;

/** Create a throwaway user through the endpoint under test. */
async function createUser(label: string, role: "user" | "admin" = "user"): Promise<Throwaway> {
  const email = `conf-ba-${label}-${ns()}@bench.local`.toLowerCase();
  const r = await cookieApi<{ user: { id: string; email: string; role?: string } }>(
    adminCk,
    "/api/auth/admin/create-user",
    { body: { email, password: PW, name: label, role } },
  );
  expect(r.status, `create-user ${label}: ${JSON.stringify(r.body)}`).toBe(200);
  const id = r.body.user.id;
  expect(id).toBeTruthy();
  expect(r.body.user.email).toBe(email);
  createdUserIds.push(id);
  return { id, email, password: PW };
}

beforeAll(async () => {
  if (!hasAdminIdentity || env.authMode !== "user") return;
  adminCk = await adminCookie();
  subject = await createUser("subject");
}, 60_000);

afterAll(async () => {
  for (const id of createdUserIds) {
    try {
      // DELETE /v1/admin/users/{id} also reaps the user's entries and
      // tokens; admin/remove-user only drops the account row.
      const r = await adminCookieApi(`/v1/admin/users/${id}`, { method: "DELETE" });
      if (r.status !== 200 && r.status !== 404) {
        console.warn(`cleanup: delete throwaway user ${id} → ${r.status}`, r.body);
      }
    } catch (e) {
      console.warn(`cleanup: delete throwaway user ${id} failed`, e);
    }
  }
});

const gated = describe.skipIf(env.authMode !== "user" || !hasAdminIdentity);

if (env.authMode !== "user" || !hasAdminIdentity) {
  // Loud skip: no silent green when this run has no admin identity.
  it.skip(
    "/api/auth/* needs auth mode=user + NOVAMEM_ADMIN_COOKIE or EMAIL+PASSWORD — skipped",
    () => {},
  );
}

// ─── Public / unauthenticated surface ──────────────────────────────────
gated("/api/auth/* — public surface", () => {
  it("GET /api/auth/jwks publishes the session-JWT verification keys", async () => {
    const r = await api<{ keys: Array<{ kid: string; alg: string; kty: string }> }>(
      "/api/auth/jwks",
      { token: "" },
    );
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.keys)).toBe(true);
    expect(r.body.keys.length).toBeGreaterThan(0);
    for (const k of r.body.keys) {
      expect(k.kid).toBeTruthy();
      expect(k.alg).toBeTruthy();
      expect(k.kty).toBeTruthy();
    }
  });

  it("GET /api/auth/get-session without a session is 200 with a null body", async () => {
    const r = await api<unknown>("/api/auth/get-session", { token: "" });
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
  });
});

// ─── Session lifecycle, driven entirely on the throwaway account ───────
gated("/api/auth/* — session lifecycle", () => {
  let ck = "";
  let secondCookie = "";

  it("POST /api/auth/sign-in/email mints a session cookie and returns the user", async () => {
    const raw = await signInRaw(subject.email, subject.password);
    expect(raw.status).toBe(200);
    const r = raw as { status: number; body: { token: string; user: { id: string; email: string } }; headers: Headers };
    expect(r.body.token).toBeTruthy();
    expect(r.body.user.id).toBe(subject.id);
    expect(r.body.user.email).toBe(subject.email);
    ck = cookieHeaderFrom(r);
    expect(ck).toMatch(/session_token=/);
  });

  it("GET /api/auth/get-session resolves that cookie to the same user", async () => {
    const r = await cookieApi<{ session: { userId: string }; user: { id: string; role?: string } }>(
      ck,
      "/api/auth/get-session",
    );
    expect(r.status).toBe(200);
    expect(r.body.session.userId).toBe(subject.id);
    expect(r.body.user.id).toBe(subject.id);
  });

  it("POST /api/auth/get-session is 405 — the route is mounted, the method is refused", async () => {
    // Mounted (our allow-list registers all five methods on every path),
    // but Better Auth itself only serves GET unless `deferSessionRefresh`
    // is on. The 405 + code is what proves the passthrough reached BA
    // rather than our own allow-list 404.
    const r = await cookieApi<{ code: string }>(ck, "/api/auth/get-session", { body: {} });
    expect(r.status).toBe(405);
    expect(r.body.code).toBe("METHOD_NOT_ALLOWED_DEFER_SESSION_REQUIRED");
  });

  it("GET /api/auth/token issues a verifiable session JWT", async () => {
    const r = await cookieApi<{ token: string }>(ck, "/api/auth/token");
    expect(r.status).toBe(200);
    expect(r.body.token.split(".")).toHaveLength(3);
    const header = JSON.parse(Buffer.from(r.body.token.split(".")[0]!, "base64url").toString());
    expect(header.kid).toBeTruthy();
    const claims = JSON.parse(Buffer.from(r.body.token.split(".")[1]!, "base64url").toString());
    expect(claims.email).toBe(subject.email);
  });

  it("GET /api/auth/list-sessions lists the caller's own sessions", async () => {
    const second = await signIn(subject.email, subject.password);
    const r = await cookieApi<Array<{ id: string; token: string; userId: string }>>(
      ck,
      "/api/auth/list-sessions",
    );
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBeGreaterThanOrEqual(2);
    for (const s of r.body) expect(s.userId).toBe(subject.id);
    // Park the second cookie for the revoke test below.
    secondCookie = second;
  });

  it("POST /api/auth/revoke-session kills exactly the named session", async () => {
    const sessions = await cookieApi<Array<{ token: string }>>(ck, "/api/auth/list-sessions");
    const mine = await cookieApi<{ session: { token: string } }>(ck, "/api/auth/get-session");
    const victim = sessions.body.find((s) => s.token !== mine.body.session.token);
    expect(victim, "need a second session to revoke").toBeTruthy();

    const r = await cookieApi<{ status: boolean }>(ck, "/api/auth/revoke-session", {
      body: { token: victim!.token },
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe(true);

    // The revoked cookie no longer resolves; ours still does.
    const dead = await cookieApi<unknown>(secondCookie, "/api/auth/get-session");
    expect(dead.status).toBe(200);
    expect(dead.body).toBeNull();
    const alive = await cookieApi<{ user: { id: string } }>(ck, "/api/auth/get-session");
    expect(alive.body.user.id).toBe(subject.id);
  });

  it("POST /api/auth/change-password rejects the wrong current password, accepts the right one", async () => {
    const wrong = await cookieApi<{ code: string }>(ck, "/api/auth/change-password", {
      body: { currentPassword: "definitely-not-the-password", newPassword: PW2 },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("INVALID_PASSWORD");

    const ok = await cookieApi<{ user: { id: string } }>(ck, "/api/auth/change-password", {
      body: { currentPassword: subject.password, newPassword: PW2 },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.user.id).toBe(subject.id);
    subject.password = PW2;

    // The new password really is in force.
    ck = await signIn(subject.email, subject.password);
  });

  it("POST /api/auth/sign-out clears the session", async () => {
    const r = await cookieApi<{ success: boolean }>(ck, "/api/auth/sign-out", { body: {} });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);

    const after = await cookieApi<unknown>(ck, "/api/auth/get-session");
    expect(after.status).toBe(200);
    expect(after.body).toBeNull();
  });
});

// ─── Admin plugin surface ──────────────────────────────────────────────
gated("/api/auth/admin/* — admin plugin", () => {
  it("GET /api/auth/admin/list-users returns the account list", async () => {
    const r = await cookieApi<{ users: Array<{ id: string; email: string; role?: string }> }>(
      adminCk,
      "/api/auth/admin/list-users?limit=500",
    );
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.users)).toBe(true);
    expect(r.body.users.some((u) => u.id === subject.id)).toBe(true);
  });

  it("POST /api/auth/admin/create-user provisions an account that can sign in", async () => {
    const fresh = await createUser("created");
    const ck = await signIn(fresh.email, fresh.password);
    const session = await cookieApi<{ user: { id: string; role?: string } }>(
      ck,
      "/api/auth/get-session",
    );
    expect(session.body.user.id).toBe(fresh.id);
    expect(session.body.user.role).toBe("user");
  });

  it("POST /api/auth/admin/update-user edits a mutable field", async () => {
    const r = await cookieApi<{ id?: string; name?: string }>(
      adminCk,
      "/api/auth/admin/update-user",
      { body: { userId: subject.id, data: { name: "conformance-renamed" } } },
    );
    expect(r.status).toBe(200);
    const listed = await cookieApi<{ users: Array<{ id: string; name: string }> }>(
      adminCk,
      "/api/auth/admin/list-users?limit=500",
    );
    expect(listed.body.users.find((u) => u.id === subject.id)?.name).toBe("conformance-renamed");
  });

  it("POST /api/auth/admin/set-role promotes and demotes", async () => {
    const promote = await cookieApi<{ user: { role: string } }>(adminCk, "/api/auth/admin/set-role", {
      body: { userId: subject.id, role: "admin" },
    });
    expect(promote.status).toBe(200);
    expect(promote.body.user.role).toBe("admin");

    const demote = await cookieApi<{ user: { role: string } }>(adminCk, "/api/auth/admin/set-role", {
      body: { userId: subject.id, role: "user" },
    });
    expect(demote.status).toBe(200);
    expect(demote.body.user.role).toBe("user");
  });

  it("POST /api/auth/admin/set-user-password replaces a password without the old one", async () => {
    const r = await cookieApi<unknown>(adminCk, "/api/auth/admin/set-user-password", {
      body: { userId: subject.id, newPassword: PW },
    });
    expect(r.status).toBe(200);
    subject.password = PW;
    // Proof, not just a 200: the new password signs in.
    const ck = await signIn(subject.email, subject.password);
    expect(ck).toMatch(/session_token=/);
  });

  it("POST /api/auth/admin/ban-user then unban-user gates and restores sign-in", async () => {
    const ban = await cookieApi<{ user: { banned: boolean } }>(adminCk, "/api/auth/admin/ban-user", {
      body: { userId: subject.id, banReason: "conformance probe" },
    });
    expect(ban.status).toBe(200);
    expect(ban.body.user.banned).toBe(true);

    const denied = await signInRaw(subject.email, subject.password);
    expect(denied.status).toBe(403);
    expect((denied.body as { code: string }).code).toBe("BANNED_USER");

    const unban = await cookieApi<{ user: { banned: boolean | null } }>(
      adminCk,
      "/api/auth/admin/unban-user",
      { body: { userId: subject.id } },
    );
    expect(unban.status).toBe(200);
    expect(unban.body.user.banned).toBeFalsy();

    const ck = await signIn(subject.email, subject.password);
    expect(ck).toMatch(/session_token=/);
  });

  it("POST /api/auth/admin/list-user-sessions + revoke-user-session + revoke-user-sessions", async () => {
    const a = await signIn(subject.email, subject.password);
    await signIn(subject.email, subject.password);

    const listed = await cookieApi<{ sessions: Array<{ token: string; userId: string }> }>(
      adminCk,
      "/api/auth/admin/list-user-sessions",
      { body: { userId: subject.id } },
    );
    expect(listed.status).toBe(200);
    expect(listed.body.sessions.length).toBeGreaterThanOrEqual(2);
    for (const s of listed.body.sessions) expect(s.userId).toBe(subject.id);

    // Revoke one by token — that cookie dies, the account keeps others.
    const mine = await cookieApi<{ session: { token: string } }>(a, "/api/auth/get-session");
    const one = await cookieApi<{ success?: boolean }>(
      adminCk,
      "/api/auth/admin/revoke-user-session",
      { body: { sessionToken: mine.body.session.token } },
    );
    expect(one.status).toBe(200);
    const dead = await cookieApi<unknown>(a, "/api/auth/get-session");
    expect(dead.body).toBeNull();

    const all = await cookieApi<{ success?: boolean }>(
      adminCk,
      "/api/auth/admin/revoke-user-sessions",
      { body: { userId: subject.id } },
    );
    expect(all.status).toBe(200);
    const remaining = await cookieApi<{ sessions: unknown[] }>(
      adminCk,
      "/api/auth/admin/list-user-sessions",
      { body: { userId: subject.id } },
    );
    expect(remaining.body.sessions).toHaveLength(0);
  });

  it("POST /api/auth/admin/impersonate-user then stop-impersonating", async () => {
    const imp = await cookieApi<{ user: { id: string } }>(
      adminCk,
      "/api/auth/admin/impersonate-user",
      { body: { userId: subject.id } },
    );
    expect(imp.status).toBe(200);
    expect(imp.body.user.id).toBe(subject.id);
    const impCk = cookieHeaderFrom(imp);
    expect(impCk).toBeTruthy();

    // The impersonation session resolves as the target, stamped with who
    // is behind it.
    const asTarget = await cookieApi<{
      session: { impersonatedBy: string | null };
      user: { id: string };
    }>(impCk, "/api/auth/get-session");
    expect(asTarget.body.user.id).toBe(subject.id);
    expect(asTarget.body.session.impersonatedBy).toBeTruthy();

    const stop = await cookieApi<unknown>(impCk, "/api/auth/admin/stop-impersonating", { body: {} });
    expect(stop.status).toBe(200);
  });

  it("POST /api/auth/admin/remove-user deletes the account", async () => {
    const doomed = await createUser("removed");
    const r = await cookieApi<{ success?: boolean }>(adminCk, "/api/auth/admin/remove-user", {
      body: { userId: doomed.id },
    });
    expect(r.status).toBe(200);
    createdUserIds.splice(createdUserIds.indexOf(doomed.id), 1);

    const listed = await cookieApi<{ users: Array<{ id: string }> }>(
      adminCk,
      "/api/auth/admin/list-users?limit=500",
    );
    expect(listed.body.users.some((u) => u.id === doomed.id)).toBe(false);
  });
});

// ─── Endpoints that are mounted but unconfigured on this target ────────
gated("/api/auth/* — mounted-but-unconfigured email flows", () => {
  // These four are on the allow-list, so they must NOT answer with OUR
  // `{"error":"not found"}`. What they DO answer is Better Auth's own
  // "this flow isn't wired up" — which is what proves the passthrough
  // reached Better Auth. Asserting the exact code (rather than just
  // "not our 404") is what makes this a contract rather than a smoke test.
  it("POST /api/auth/forget-password is Better Auth's own 404, not the allow-list's", async () => {
    const r = await api<unknown>("/api/auth/forget-password", {
      body: { email: "conformance-nobody@bench.local" },
      token: "",
    });
    expect(r.status).toBe(404);
    expect(isAllowlistDenial(r.body)).toBe(false);
  });

  it("POST /api/auth/reset-password rejects a bogus token with INVALID_TOKEN", async () => {
    const r = await api<{ code: string }>("/api/auth/reset-password", {
      body: { newPassword: "irrelevant-but-long-enough", token: "conformance-bogus-token" },
      token: "",
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("INVALID_TOKEN");
  });

  it("GET /api/auth/verify-email validates its query before anything else", async () => {
    const r = await api<{ code: string }>("/api/auth/verify-email", { token: "" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("VALIDATION_ERROR");
  });

  it("POST /api/auth/send-verification-email reports the flow is disabled", async () => {
    const r = await api<{ code: string }>("/api/auth/send-verification-email", {
      body: { email: "conformance-nobody@bench.local" },
      token: "",
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("VERIFICATION_EMAIL_NOT_ENABLED");
  });
});

// ─── Contract negatives ────────────────────────────────────────────────
gated("/api/auth/* — allow-list and authorization negatives", () => {
  it("POST /api/auth/sign-up/email is 404 — open self-registration is not a supported flow", async () => {
    const r = await api<unknown>("/api/auth/sign-up/email", {
      body: {
        email: `conf-signup-must-404-${ns()}@bench.local`,
        password: "should-never-be-created",
        name: "nope",
      },
      token: "",
    });
    expect(r.status).toBe(404);
    expect(ErrorBody.parse(r.body).error).toBe("not found");
  });

  it("an unknown /api/auth/* path is 404 on every method", async () => {
    for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"] as const) {
      const r = await api<unknown>("/api/auth/not-on-the-allowlist", {
        method,
        ...(method === "GET" || method === "DELETE" ? {} : { body: {} }),
        token: "",
      });
      expect(r.status, `${method} /api/auth/not-on-the-allowlist`).toBe(404);
      expect(isAllowlistDenial(r.body), `${method} body: ${JSON.stringify(r.body)}`).toBe(true);
    }
  });

  it("a deep unknown path under the admin subtree is 404, not a wildcard passthrough", async () => {
    const r = await api<unknown>("/api/auth/admin/some-new-endpoint", { body: {}, token: "" });
    expect(r.status).toBe(404);
    expect(isAllowlistDenial(r.body)).toBe(true);
  });

  it("an unauthenticated caller is refused on the admin subtree", async () => {
    const r = await api<unknown>("/api/auth/admin/list-users?limit=1", { token: "" });
    // Better Auth answers 401 with an EMPTY body here (no `code`) — which
    // also proves it isn't our allow-list's `{"error":"not found"}`.
    expect(r.status).toBe(401);
    expect(isAllowlistDenial(r.body)).toBe(false);
  });

  it("a signed-in NON-admin is refused on the admin subtree with the permission code", async () => {
    const ck = await signIn(subject.email, subject.password);
    const list = await cookieApi<{ code?: string }>(ck, "/api/auth/admin/list-users?limit=1");
    expect(list.status).toBe(403);
    expect(list.body.code).toBe("YOU_ARE_NOT_ALLOWED_TO_LIST_USERS");

    const create = await cookieApi<{ code?: string }>(ck, "/api/auth/admin/create-user", {
      body: { email: `conf-nonadmin-${ns()}@bench.local`, password: PW, name: "nope" },
    });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe("YOU_ARE_NOT_ALLOWED_TO_CREATE_USERS");
  });

  it("LAST_ADMIN_PROTECTED blocks removing/demoting the only admin", async (ctx) => {
    // `guardLastAdmin` fires only when the TARGET is the sole surviving
    // admin. On a target with several admins the same call would really
    // delete one, so skip loudly rather than assert destructively.
    const listed = await cookieApi<{ users: Array<{ id: string; role?: string }> }>(
      adminCk,
      "/api/auth/admin/list-users?limit=500",
    );
    const admins = listed.body.users.filter((u) => u.role === "admin");
    if (admins.length !== 1) {
      ctx.skip(`target has ${admins.length} admins — the guard can only be probed with exactly 1`);
      return;
    }
    const soleAdmin = admins[0]!.id;

    const remove = await cookieApi<{ error: string; code: string }>(
      adminCk,
      "/api/auth/admin/remove-user",
      { body: { userId: soleAdmin } },
    );
    expect(remove.status).toBe(400);
    expect(remove.body.code).toBe("LAST_ADMIN_PROTECTED");
    expect(remove.body.error).toBe("cannot delete the last admin — promote another user first");

    const demote = await cookieApi<{ error: string; code: string }>(
      adminCk,
      "/api/auth/admin/set-role",
      { body: { userId: soleAdmin, role: "user" } },
    );
    expect(demote.status).toBe(400);
    expect(demote.body.code).toBe("LAST_ADMIN_PROTECTED");
    expect(demote.body.error).toBe("cannot demote the last admin — promote another user first");

    // The guard runs BEFORE Better Auth's own authorization, so it must
    // still hold — and still delete nothing — for a caller with no
    // credentials at all.
    const unauth = await api<{ code: string }>("/api/auth/admin/remove-user", {
      body: { userId: soleAdmin },
      token: "",
    });
    expect(unauth.status).toBe(400);
    expect(unauth.body.code).toBe("LAST_ADMIN_PROTECTED");

    // Proof the guard was a no-op, not a delete-then-complain.
    const after = await cookieApi<{ users: Array<{ id: string; role?: string }> }>(
      adminCk,
      "/api/auth/admin/list-users?limit=500",
    );
    expect(after.body.users.find((u) => u.id === soleAdmin)?.role).toBe("admin");
  });

  it("setting the sole admin's role to admin is NOT blocked (no-op promotion)", async (ctx) => {
    const listed = await cookieApi<{ users: Array<{ id: string; role?: string }> }>(
      adminCk,
      "/api/auth/admin/list-users?limit=500",
    );
    const admins = listed.body.users.filter((u) => u.role === "admin");
    if (admins.length !== 1) {
      ctx.skip(`target has ${admins.length} admins`);
      return;
    }
    // guardLastAdmin returns early when `role === "admin"` — the admin
    // count cannot drop, so the guard must not fire.
    const r = await cookieApi<{ user?: { role: string } }>(adminCk, "/api/auth/admin/set-role", {
      body: { userId: admins[0]!.id, role: "admin" },
    });
    expect(r.status).toBe(200);
  });
});

// ─── Sign-in throttle ──────────────────────────────────────────────────
// Deliberately LAST in the file: it exhausts Better Auth's own per-IP
// sign-in budget, and anything running after it in the same second would
// see spurious 429s. Unlike the global rate limiter (a 1-minute window
// that would poison the whole run, see 43-cors-ratelimit) this one is a
// ~10-second window, so exhausting it here is cheap and self-healing.
gated("/api/auth/sign-in/email — throttle", () => {
  it("rapid repeated sign-ins are throttled with Better Auth's own 429", async () => {
    // Correct credentials throughout: this proves the THROTTLE, not the
    // credential check, and leaves novamem's per-account 5-strike
    // limiter (15-minute window) untouched.
    let throttled: { status: number; body: unknown } | null = null;
    for (let i = 0; i < 8; i++) {
      const r = await api<unknown>("/api/auth/sign-in/email", {
        body: { email: subject.email, password: subject.password },
        token: "",
        headers: env.origin ? { origin: env.origin } : {},
      });
      if (r.status === 429) {
        throttled = r;
        break;
      }
      expect(r.status).toBe(200);
    }
    expect(throttled, "8 back-to-back sign-ins were not throttled").toBeTruthy();
    expect((throttled!.body as { message: string }).message).toBe(
      "Too many requests. Please try again later.",
    );
  }, 60_000);
});
