# Phase 2a — Security Audit (Deep)

Scope: novamem multi-tenant memory service. Auth = bcrypt sessions (`ns_…`) + tenant tokens (`nm_…`) + legacy admin bearer. Project (sub-brain) authorisation crosses tenant boundaries by design: in shared projects, `project_id` is the access boundary and `tenant_id` is decorative. Audit covers OWASP Top 10, project-scope authorisation, token handling, auth flow, CSP/CORS, configuration, dependencies, rate limiting, and operational hygiene.

## Summary

| Severity | Count |
|---|---|
| Critical | 4 |
| High | 9 |
| Medium | 11 |
| Low | 6 |
| **Total** | **30** |

Top concerns:

1. **S-C1 / A2 Tenant-id prefix collision** in cold-store `deleteAllForTenant` is an exploitable cross-project data-loss vector. Confirmed: tenant id regex permits `p`, `p_*`.
2. **S-C2 / C2 `removeProjectMember` leaks credentials** — removed members keep working tokens until separately revoked.
3. **S-C3 Login is not rate-limited per-username.** Per-IP only, plus bcrypt cost 10. Online password-guessing is feasible from a botnet.
4. **S-C4 `getEntry()` `projectId === "*"` magic-string bypass** — public-API tripwire that turns any future caller mistake into a full cross-project leak.
5. **S-H1 SSE-MCP session smuggling (H7)** confirmed — `POST /mcp/messages` only checks `sessionId`, not the bearer.
6. **S-H2 Cross-tenant `forget` on shared projects silently no-ops** because DELETEs filter by `tenant_id` (entry's owner tenant, not bearer's).
7. **S-H3 Pino has no `redact` for Authorization / password / token** — bearer plaintext and the bootstrap admin password can land in logs (4xx body logging, error logs).
8. **S-H4 Dashboard token in `sessionStorage`** is XSS-recoverable; combined with Swagger UI's `'unsafe-inline'` style-src and CORS `origin: true`, the post-XSS blast radius is full account takeover.
9. **S-H5 No session GC** — sessions accumulate forever (also C1 in Phase 1). Token-hash compromise window is unbounded after server restart.
10. **S-H6 Bootstrap admin password on stdout** — `bootstrapAdmin` log doesn't print the password but `console.log` of the username at INFO level plus the env-var primitive means the password lives in `docker inspect`, container env, and any restart log.

---

## Critical

### S-C1 — Tenant id `p` / `p_<anything>` causes cross-project data destruction via `deleteAllForTenant`
**Severity:** Critical  **CWE-863** (Incorrect Authorization)  **CVSS 8.1 (AV:N/AC:H/PR:H/UI:N/S:C/C:N/I:H/A:H)**

`packages/server/src/cold-store.ts:131-146` enumerates qdrant collections by string prefix `novamem_<tenantId>_`. Project-scoped collections are named `novamem_p_<projectId>_<namespace>` (line 46). The tenant-id slug regex (`/^[a-z0-9][a-z0-9_-]*$/`, `http.ts:110`) permits `p`, `p_demo`, `p_acme`, etc.

Attack: any admin (or a compromised admin token) creates a tenant `p_demo`, then deletes it. The `deleteAllForTenant` prefix scan matches every project-scoped collection whose project id starts with `demo_` (`novamem_p_demo_…`), wiping shared-project vector data across all tenants. Single-letter tenant id `p` matches *every* project-scoped collection in the cluster.

The same regex would also let an admin create tenant id `public` aliasing the synthetic public tenant — `deleteTenant` refuses `public` only, but `p_public` etc. cross both the project namespace and any future special-cased prefix.

**Fix (concrete):** disallow tenant ids that start with `p_` or equal `p`, and embed the tenant id in the project-scoped collection too so prefix-walks can't escape:

```ts
// http.ts:110
const TENANT_RESERVED = /^p(_|$)/;
const AdminCreateTenantBody = z.object({
  id: z.string().min(2).max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/)
    .refine((s) => !TENANT_RESERVED.test(s), {
      message: "tenant id must not start with reserved prefix 'p' or 'p_'",
    }),
  ...
});

// cold-store.ts:46
private collectionFor(tenantId, namespace, projectId = null) {
  if (projectId) return `novamem_p_${projectId}__${namespace}`;
  return `novamem_t_${tenantId}__${namespace}`; // gain a 't_' namespace so 'p_' tenants are structurally impossible
}
```

A migration is needed: rename existing collections OR (simpler) keep the current names and only add the `TENANT_RESERVED` validator; existing `p_*` tenants — if any — must be enumerated and migrated. **Audit existing tenants now**:

```sql
SELECT id FROM tenants WHERE id ~ '^p($|_)';
```

---

### S-C2 — `removeProjectMember` does not revoke that user's project-scoped tokens
**Severity:** Critical  **CWE-613** (Insufficient Session Expiration)  **CVSS 7.7 (AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:N)**

`packages/server/src/http.ts:776-794` and `packages/server/src/warm-store/index.ts:694-700`: removing user X from project P deletes the row from `project_members` but leaves any `tenant_tokens` row with `(created_by_user_id = X, project_id = P, revoked_at IS NULL)` live. The auth-hook (`http.ts:343-349`) resolves the bearer's `(tenantId, projectId)` via `resolveTenantToken` — which does not consult membership at runtime — so the kicked-out user keeps reading and writing the project until either: (a) they re-mint (membership is rechecked at `me/tokens` POST, line 682), or (b) the project owner deletes the project, or (c) admin tenant-deletes.

**PoC:**
1. Owner adds Mallory to project `P`.
2. Mallory mints `nm_xyz` scoped to `P` via `POST /v1/me/tokens`.
3. Owner removes Mallory via `DELETE /v1/me/projects/P/members/<mallory>`.
4. Mallory still authenticates with `nm_xyz`, reads + writes shared memory in `P`.

**Fix:** revoke the user's project-scoped tokens in the same transaction as the member removal:

```ts
// warm-store/index.ts:removeProjectMember
async removeProjectMember(projectId: string, userId: string): Promise<boolean> {
  const client = await this.pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`,
      [projectId, userId],
    );
    await client.query(
      `UPDATE tenant_tokens SET revoked_at = now()
        WHERE project_id = $1 AND created_by_user_id = $2 AND revoked_at IS NULL`,
      [projectId, userId],
    );
    await client.query("COMMIT");
    return (r.rowCount ?? 0) > 0;
  } catch (err) { await client.query("ROLLBACK").catch(() => undefined); throw err; }
  finally { client.release(); }
}
```

Defence-in-depth: also recheck membership inside `resolveTenantToken` when `project_id IS NOT NULL`:

```ts
WHERE token_hash = $1 AND revoked_at IS NULL
  AND (project_id IS NULL
       OR EXISTS (SELECT 1 FROM project_members pm
                  WHERE pm.project_id = tenant_tokens.project_id
                    AND pm.user_id = tenant_tokens.created_by_user_id))
```

---

### S-C3 — `POST /v1/auth/login` has no per-username brute-force protection
**Severity:** Critical  **CWE-307** (Improper Restriction of Excessive Authentication Attempts)  **CVSS 7.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N)**

`packages/server/src/http.ts:240-246` registers `@fastify/rate-limit` at 600 req/min per-IP across all routes (allow-list = `/health` only). Login at `:533-557` runs bcrypt cost 10 (~80 ms) and returns 401 on failure. There is no per-username counter, no exponential backoff, no account lockout, no captcha, no notification on repeated failures. An attacker behind a botnet (10k IPs × 600 rpm = 6M tries/min) can grind passwords. The constant-time-ish branch (`auth.ts:29` calls `bcrypt.compare` against a fixed dummy hash) is defensive but bcrypt's variable cost between known-format and malformed hashes still leaks a small timing differential — minor issue (see S-M3).

The dashboard creates an admin with bootstrap env password — first-deploy password is human-typed and weak by default.

**Fix:**
- Add per-username login throttle: maintain `login_attempts(user_id, attempt_at)` and reject after N failures in M minutes, OR adopt `@fastify/rate-limit`'s `keyGenerator` for a username-keyed bucket on `/v1/auth/login`:

```ts
app.register(rateLimit, { /* … global … */ });
// Tighter bucket on login, keyed by both IP AND username
app.post("/v1/auth/login", {
  config: {
    rateLimit: {
      max: 5,
      timeWindow: "15 minutes",
      keyGenerator: (req) => {
        const u = (req.body as { username?: string } | null)?.username ?? "";
        return `login:${req.ip}:${u}`;
      },
    },
  },
}, /* handler */);
```

- Increment a metric `auth_login_failures_total{user=…}` so spike alerts fire on suspicious bursts.
- Bcrypt cost 10 → 12 (the median 2026 recommendation for new deploys; ~250 ms on commodity x86). One-line change in `auth.ts:21`.
- Add minimum-password-length policy on `bootstrapAdmin` (refuse < 12 chars in production mode).

---

### S-C4 — `getEntry()` `projectId === "*"` magic-string bypass
**Severity:** Critical  **CWE-285** (Improper Authorization) — *latent; no caller currently passes `"*"`*

`packages/server/src/warm-store/index.ts:847-864`: `getEntry` accepts an opts.projectId of `"*"` that disables the tenant + project access checks entirely. No production caller passes `"*"` today, but the function signature is publicly exposed via `WarmStore.getEntry` and the magic value is undocumented in the type system (`projectId?: string | null` allows it). This is a tripwire — the next refactor that forwards an externally-influenced project id to `getEntry` ships a full bypass.

**Fix:** delete the bypass branch; if there is a legitimate cross-tenant lookup (decay loop?), give it a separate, explicit method:

```ts
// warm-store/index.ts:847
async getEntry(tenantId: string, id: string, opts: { projectId?: string | null } = {}) {
  // … existing body, but DELETE this branch:
  // if (opts.projectId === "*") return row;
}

// And expose an audited unsafe variant ONLY where needed:
async unsafeGetEntryAnyScope(id: string) {
  /* used by decay loop; never wired to a request handler */
}
```

`grep -rn 'projectId.*"\*"' packages/server/src` to confirm no caller depends on it. (Phase 1 A1 already flagged this; its persistence here is the issue.)

---

## High

### S-H1 — SSE-MCP `/mcp/messages` does not verify the request bearer matches the captured session
**Severity:** High  **CWE-287** (Improper Authentication)  **CVSS 7.1 (AV:N/AC:H/PR:L/UI:N/S:U/C:H/I:H/A:N)**

`packages/server/src/http.ts:946-952`: `POST /mcp/messages?sessionId=…` only validates the sessionId string against the in-memory map. There is no check that the auth-hook-resolved `req.tenantId` / `req.bearerProjectId` matches the session captured at SSE handshake. Any other authenticated tenant who guesses (or sniffs from logs — see S-H3) a 22-char `sessionId` can submit JSON-RPC tool calls into another tenant's MCP session.

**Attack:** Tenant A opens an SSE session; the sessionId leaks via `info` log line `mcp-sse: session opened` (http.ts:938). Tenant B with any valid bearer POSTs to `/mcp/messages?sessionId=<A's id>` and pivots into A's `tenantId` for the call.

**Fix:**

```ts
app.post("/mcp/messages", async (req, reply) => {
  const sessionId = (req.query as { sessionId?: string }).sessionId;
  if (!sessionId) return reply.code(400).send({ error: "missing sessionId" });
  const session = sseTransports.get(sessionId);
  if (!session) return reply.code(404).send({ error: "unknown sessionId" });
  // Bind: the bearer that opened the SSE session is the only one allowed
  // to push messages on it.
  if (req.tenantId !== session.tenantId
      || (req.bearerProjectId ?? null) !== (session.projectId ?? null)) {
    return reply.code(403).send({ error: "session bearer mismatch" });
  }
  await session.transport.handlePostMessage(req.raw, reply.raw, req.body);
});
```

Also persist `projectId` and `userId` in the `sseTransports` value, not just `tenantId`.

---

### S-H2 — Cross-tenant `forget` on shared projects silently no-ops (Phase-1 A3 confirmed)
**Severity:** High  **CWE-863** (Incorrect Authorization) — *availability of mutation, not data leak*

`packages/server/src/engine/index.ts:382-426`: `forget()` calls `getEntry(tenantId, id, { projectId })` (correct — project is the access boundary), but the subsequent DELETEs bind `tenant_id = $2` to the **bearer's** tenant. For a project member from a different tenant than the entry's `tenant_id` author, the DELETE matches zero rows — the function returns `{ deleted: true, coldDeleteOk: true }` (because `getEntry` succeeded) but the warm row is still alive. Subsequent searches still surface it.

Lines 390, 393, 396: every DELETE is `... AND tenant_id = $2`.
Line 399: `graph.removeNode(tenantId, id)` — same bug; the graph row carries the *creator's* tenant.

**PoC:**
1. User Alice (tenant A) is a project P member, remembers entry E (E's row tenant_id=A).
2. User Bob (tenant B) is a project P member.
3. Bob calls `forget(E)`. `getEntry` allows it (project match). DELETE sees tenant_id=B mismatch — no-ops.
4. `forget` returns `deleted: true`. E persists.

**Fix:** for project-scoped entries, scope DELETEs by `project_id` instead of `tenant_id`:

```ts
async forget(tenantId, id, opts = {}) {
  const e = await this.warm.getEntry(tenantId, id, { projectId: opts.project ?? null });
  if (!e) return { deleted: false, coldDeleteOk: true };
  this.metrics?.recordForget(tenantId);
  const pool = this.warm.pool;
  // Use the entry's actual ownership for the DELETE — getEntry already enforced access.
  const ownerTenant = e.tenantId;
  const proj = e.projectId;
  if (proj) {
    await pool.query("DELETE FROM memory_fts WHERE entry_id = $1 AND project_id = $2", [id, proj]);
    await pool.query("DELETE FROM memory_relations WHERE (from_id = $1 OR to_id = $1) AND project_id = $2", [id, proj]);
    await pool.query("DELETE FROM memory_entries WHERE id = $1 AND project_id = $2", [id, proj]);
  } else {
    await pool.query("DELETE FROM memory_fts WHERE entry_id = $1 AND tenant_id = $2", [id, ownerTenant]);
    await pool.query("DELETE FROM memory_relations WHERE (from_id = $1 OR to_id = $1) AND tenant_id = $2", [id, ownerTenant]);
    await pool.query("DELETE FROM memory_entries WHERE id = $1 AND tenant_id = $2", [id, ownerTenant]);
  }
  await pool.query("DELETE FROM memory_access WHERE entry_id = $1", [id]);
  if (this.graph?.isConnected()) {
    try { await this.graph.removeNode(proj ? ownerTenant : tenantId, id); } catch { /* … */ }
  }
  // cold.delete uses the entry's projectId-derived collection; already correct.
}
```

Also fix `graph.removeNode` to take an explicit project filter so cross-tenant project nodes get matched by node id alone (single-tenant filter doesn't match a different-tenant author's node).

---

### S-H3 — Pino has no `redact` rules; Authorization, password, and token plaintext can be logged
**Severity:** High  **CWE-532** (Insertion of Sensitive Information into Log File)

`packages/server/src/http.ts:204` constructs Fastify with `{ logger: { level: process.env.LOG_LEVEL ?? "info" } }`. No `redact: ["req.headers.authorization", "req.body.password", "res.body.token", …]`. Fastify's default request log line includes `req.headers` at `trace` level only — but Zod validation errors thrown inside handlers (e.g. `LoginBody.parse(req.body)` at line 535) bubble up; Fastify's default error log path serialises `error.message` containing the offending field value. A malformed login body that fails Zod sends the password into `error.issues[].path`/value pairs (and on `at` `info` level for unhandled errors).

Also, `http.ts:938` logs `{ sessionId, tenantId }` — sessionId leakage feeds S-H1.

**Fix:**

```ts
const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.password',
        'req.body.token',
        'res.body.token',
        '*.password',
        '*.passwordHash',
      ],
      censor: '[REDACTED]',
    },
  },
  bodyLimit: 2 * 1024 * 1024,
});
```

Also: change Zod parse failures into 400s with a generic message instead of letting Fastify auto-log them, and stop logging `sessionId` at info — drop it to debug or hash it.

---

### S-H4 — Dashboard token in `sessionStorage` + Swagger UI `'unsafe-inline'` style-src + CORS `origin: true` = post-XSS account takeover
**Severity:** High  **CWE-79** (chain) / **CWE-1004** (Sensitive Cookie Without HttpOnly) — applied analogously to sessionStorage

`packages/admin-ui/src/lib/api.ts:8-17` stores `ns_<token>` in `sessionStorage` keyed `novamem_session_token`. Any successful XSS on the same origin (`/admin/*`) reads it instantly with `sessionStorage.getItem("novamem_session_token")`. The `/admin` dashboard CSP (http.ts:387-396) is tight — `script-src 'self'`, no inline — but the same origin also serves Swagger UI at `/api-docs` with `style-src 'self' 'unsafe-inline'` (line 228). Swagger UI's `tryItOutEnabled: true` + `persistAuthorization: true` (lines 220-221) means any reflected/injected content there can stage style-based exfil (CSS injection of attribute selectors against same-origin DOM is a real exfil channel).

`@fastify/cors` is registered with `origin: true` (line 205) which echoes the request `Origin` header back as `Access-Control-Allow-Origin` for any caller. With credentials disabled (default) this isn't a session-stealer by itself, but combined with `persistAuthorization` in Swagger UI the post-XSS surface is wider than necessary.

**Fixes:**

1. Move the dashboard session to an `HttpOnly; Secure; SameSite=Strict` cookie. Add a CSRF token (double-submit) for state-changing requests. The admin-ui already does same-origin fetches, so this is mostly mechanical.
2. Tighten CORS to an explicit allow-list:
   ```ts
   app.register(cors, {
     origin: (origin, cb) => {
       if (!origin) return cb(null, true); // same-origin / curl
       const allow = (process.env.NOVAMEM_CORS_ORIGINS ?? "").split(",").filter(Boolean);
       cb(null, allow.includes(origin));
     },
     credentials: true,
   });
   ```
3. Remove `'unsafe-inline'` from Swagger UI's CSP (use a nonce — `@fastify/swagger-ui` accepts a `transformStaticCSP` callback). Or, host Swagger UI on a different origin (`/api-docs` subdomain) so a CSS-injection there can't see dashboard DOM.
4. Add `X-Frame-Options: DENY` and `Strict-Transport-Security` (`@fastify/helmet` is the cheapest path; add the dep).

---

### S-H5 — Sessions never garbage-collected (also Phase 1 C1)
**Severity:** High  **CWE-613** (Insufficient Session Expiration)

`packages/server/src/warm-store/index.ts:517-527` inserts into `sessions`, never deletes (other than cascade on user delete or `revokeSession`). Resolution at `:540-547` filters `expires_at > now()` so expired sessions are inert — but they sit in the table forever. After a year of normal use the table is megabytes of liveness records; more importantly, an attacker who exfiltrates the `sessions` table on day 365 has 365 days of session token-hashes. Token-hashes are sha256(plaintext) — not directly reversible — but they enable replay if a session token leaks via any side-channel (log file, browser cache, browser extension exfil) at any point in that history. They also let you correlate a user's login pattern to identify likely VIP accounts.

`last_seen_at` updates *and* `expires_at` is fixed. So even a logged-in user's session expires hard at 24 h regardless of activity. Combined with no rotation on privilege change (e.g. role demotion), the model is half sliding, half fixed.

**Fixes:**

1. Add a periodic GC pass:
   ```ts
   // main.ts decay loop or its own timer
   setInterval(async () => {
     await warm.pool.query("DELETE FROM sessions WHERE expires_at < now() - interval '7 days'");
   }, 60 * 60 * 1000);
   ```
2. Make session TTL sliding: bump `expires_at = now() + ttl` on each `resolveSession` if the user has been idle < `idleCap` (e.g. cap absolute lifetime at 7 d).
3. Revoke all sessions for a user on role change / password change / explicit "log out everywhere".

---

### S-H6 — Bootstrap admin password in env appears in `docker inspect`, container logs, and is not rotated
**Severity:** High  **CWE-256** (Plaintext Storage of a Password) / **CWE-798** (Use of Hard-coded Credentials)

`docker-compose.yaml:50` passes `NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` directly into the container env. Any operator with `docker inspect novamem-novamem-1` reads it back. `packages/server/src/main.ts:43-51` calls `bootstrapAdmin(...)` with `process.env.NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` and (correctly) does not log the password — but the env var **stays set** for the lifetime of the process and child processes. Combine with any error logger that does `JSON.stringify(process.env)` (none here today, but it's a foot-gun).

The bootstrap path also has no enforced password complexity (the `auth.ts:54` accepts any non-empty value).

**Fixes:**

1. Use Docker secrets (file-mounted) instead of env:
   ```yaml
   secrets:
     bootstrap_admin_password:
       file: ./secrets/bootstrap_password
   services:
     novamem:
       environment:
         NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD_FILE: /run/secrets/bootstrap_admin_password
       secrets: [bootstrap_admin_password]
   ```
   Read with a `_FILE`-suffix convention in `config.ts`.
2. After `bootstrapAdmin` runs, `delete process.env.NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD` to remove from the live process env.
3. Enforce minimum length (≥ 12 chars) and refuse if it equals `"admin"`, `"password"`, etc.
4. Set `must_change_password = true` on the bootstrap admin row and gate non-password-rotation routes until rotation. (Schema change: `users.password_changed_at`, refuse all routes except `/v1/auth/me/change-password` until set.)

---

### S-H7 — `relations` orphan & cross-tenant write on shared projects (Phase 1 A11 confirmed)
**Severity:** High  **CWE-280** (Improper Handling of Insufficient Permissions) / data-integrity

`packages/server/src/warm-store/index.ts:916-931`: `addRelation` writes `tenant_id = $1` (the bearer's tenant), even when `project_id IS NOT NULL`. For a cross-tenant project member, the inserted relation row carries the bearer's tenant — different from the entry's owner tenant. Subsequent `DELETE … WHERE tenant_id = X` (in `forget`, `deleteTenant`) will not match → orphan rows pile up; semantic correctness breaks for any tenant-scoped traversal (none exists today, but `idx_relations_tenant` suggests one is expected).

**Fix:** for project-scoped writes, scope by `project_id`; alternatively, store `tenant_id` as the entry's owner, not the bearer's.

```ts
async addRelation(tenantId, fromId, toId, relation, strength, projectId = null) {
  // For project-scoped relations, we don't really need tenant_id at all —
  // project_id is the authoritative scope. Store NULL so cleanup can be
  // by project alone, eliminating the cross-tenant ambiguity.
  await this.pool.query(
    `INSERT INTO memory_relations (tenant_id, project_id, from_id, to_id, relation, strength)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (from_id, to_id, relation) DO UPDATE SET strength = EXCLUDED.strength`,
    [projectId ? tenantId /* keep for audit */ : tenantId, projectId, fromId, toId, relation, strength],
  );
}
```

And update `forget`/`deleteTenant`/`deleteProject` cleanup queries to `WHERE project_id = $1 OR (project_id IS NULL AND tenant_id = $1)` for the project path.

---

### S-H8 — `recent()` builds raw SQL by string concatenation
**Severity:** High  **CWE-89** (SQL Injection) — *not exploitable today, but fragile*

`packages/server/src/engine/index.ts:303-326`: `recent()` builds the SQL via `sql += " AND ... = $${params.length}"` and pushes `args.namespace`, `tenantId`, `projectId`, `args.since` into `params`. All current concatenations are constants — but `args.since` is an unvalidated `string` (Zod allows `z.string().optional()` at `http.ts:92`, no ISO format check). Postgres's `$N` binding still escapes it, so injection is blocked at the driver level — but **`since` going straight into a comparison without an ISO-8601 check** means a malformed string yields a backend `invalid input syntax for type timestamp` exception, surfaced as 500. Not a vulnerability per se, more a DoS amplifier (any error path that doesn't redact echoes the raw input back through Pino).

The `ftsSearch` regex-replace `scopeClause.replace(/(project_id|tenant_id)/g, "f.$1")` (warm-store/index.ts:815) is fragile under future column renames; if a future column name happens to contain `tenant_id` as a substring, the replacement misfires.

**Fixes:**

1. Tighten Zod: `since: z.string().datetime().optional()`.
2. Replace the regex hack in `ftsSearch` with two purpose-built clause builders (one for the joined query, one for the unjoined). 30 lines of duplication is cheaper than this footgun.

---

### S-H9 — No audit log of admin actions
**Severity:** High  **CWE-778** (Insufficient Logging)

There is no audit table for: create/delete tenant, create/delete user, mint/revoke token, login success/failure, change role, add/remove project member, delete project. Operators cannot answer "who minted this token?" beyond the `created_by_user_id` column on `tenant_tokens`. Forensics on a compromise is impossible.

**Fix:** add `audit_log(id, actor_user_id, actor_ip, action, target_kind, target_id, metadata jsonb, created_at)`; emit a row from each admin handler. Same table also catches login failures (S-C3).

---

## Medium

### S-M1 — Bcrypt cost factor 10
**Severity:** Medium  **CWE-916**

`packages/server/src/auth.ts:21`: `BCRYPT_ROUNDS = 10`. NIST 2026 recommendation is ≥ 12; OWASP ASVS 4.0.3 §2.4.1 recommends ≥ 10 minimum but acknowledges 12+ for dashboards. Bump to 12 (~250 ms login). Combined with S-C3 (no per-username throttle), low cost is the brute-force amplifier.

---

### S-M2 — Constant-time login comment is misleading
**Severity:** Medium  **CWE-208** (Observable Timing Discrepancy)

`packages/server/src/http.ts:539-542`: the comment claims "constant-ish-time" by always running `verifyPassword`. The throwaway hash `"$2a$10$invalidsaltinvalidsaltinvalidsaltinvalid"` is NOT a valid bcrypt format — `bcrypt.compare` returns false **fast** on a parse error (no full hash compute), so the unknown-username branch leaks via timing. Use a known-good but unmatched bcrypt hash:

```ts
// auth.ts
import bcrypt from "bcryptjs";
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", BCRYPT_ROUNDS); // computed at boot
export { DUMMY_HASH };

// http.ts:540
const ok = user
  ? await verifyPassword(body.password, user.passwordHash)
  : await verifyPassword(body.password, DUMMY_HASH);
```

---

### S-M3 — `bcryptjs` vs `bcrypt`
**Severity:** Medium  **CWE-1104** (Use of Unmaintained Third Party Components)

`packages/server/package.json:36` uses `bcryptjs@^2.4.3` (pure-JS, ~3× slower than native `bcrypt`). bcryptjs 2.x has not had a release since 2017. The native `bcrypt` package is faster (lets you raise rounds without latency) and maintained. Migration is a dependency swap (API-compatible). Side benefit: native bcrypt has a hard limit on password length (72 bytes) consistent with the bcrypt spec; bcryptjs silently allows longer (the spec truncates anyway, no risk, just noise).

---

### S-M4 — `@fastify/rate-limit` `skipOnError: true` opens a fail-open
**Severity:** Medium  **CWE-754**

`packages/server/src/http.ts:244`: `skipOnError: true` means a Redis-backed rate-limiter falling over (or any internal error) lets requests through unthrottled. With the in-memory store this matters less, but if anyone moves to a Redis backend for multi-instance deploys, the failure mode is silent unlimited login. Set `skipOnError: false` and add an alert.

---

### S-M5 — Postgres exposed on host port 5432 with default credentials
**Severity:** Medium  **CWE-521** (Weak Password) / **CWE-668** (Exposure of Resource to Wrong Sphere)

`docker-compose.yaml:8-9`: ports `5432:5432`. Combined with hardcoded `POSTGRES_PASSWORD: novamem` (line 6) → any local-network attacker (or anyone tricking a developer into `docker compose up` on a wifi network) gets full DB access. Same applies to qdrant `:6333` and falkordb `:6379`.

**Fix:** drop host port mappings unless explicitly needed; use a sidecar shell for DB access. If host access is required for dev:
```yaml
ports:
  - "127.0.0.1:5432:5432"   # localhost only, never 0.0.0.0
```
And document a strong default password / generate one at first run.

---

### S-M6 — `@fastify/cors` `origin: true` echoes any Origin
**Severity:** Medium  **CWE-942**

Already covered under S-H4. Standalone severity Medium because credentials are off, so the impact is read-anything-origin-X-can-already-read — but it disables defence-in-depth against future credentialled endpoints.

---

### S-M7 — No password complexity, no password history, no password rotation
**Severity:** Medium  **CWE-521**

`packages/server/src/http.ts:138`: `password: z.string().min(8).max(256)`. NIST 800-63B is OK with 8 if you're checking against the breach list; we don't. No history table → users can re-set the same password. No required rotation, no notification on rotation.

**Fix:** add a haveibeenpwned API check (free, k-anonymity), enforce 12 chars min when bootstrapping admins, store the last-N hashes for history checks.

---

### S-M8 — `health` endpoint leaks dependency liveness status without auth
**Severity:** Medium  **CWE-200**

`packages/server/src/http.ts:409-412`: `/health` returns `{ ok, deps: { warm, cold, graph } }` to anyone (intentionally — for k8s probes). For a production deploy that's exposed on the internet, it's reconnaissance: confirms qdrant + falkordb are present and responsive, fingerprints the stack. Move to a privileged `/admin/health` for full status; leave a 200/503 blank-body `/healthz` for probes.

---

### S-M9 — No password reset flow
**Severity:** Medium  **CWE-1390** (Missing Authorization Step)

There is no "forgot password" endpoint. The only path back into a locked-out account is direct DB access. For a deployed dashboard this is a major operational gap. **For the target operator audience (self-hosting devs), this is acceptable today; document it.** If the dashboard ships to less-technical operators, add an email-token-based reset.

---

### S-M10 — Token plaintext in successful response bodies stays in browser HTTP cache / dev tools
**Severity:** Medium  **CWE-525** (Information Exposure Through Browser Caching)

`POST /v1/auth/login` (http.ts:547-557) and `POST /v1/me/tokens` (http.ts:686-697) send plaintext tokens in the response body. Without `Cache-Control: no-store`, an intermediary or browser cache may retain it.

**Fix:**

```ts
reply.header("Cache-Control", "no-store");
reply.header("Pragma", "no-cache");
```

Apply globally to control-plane routes via an `onSend` hook.

---

### S-M11 — `Dockerfile` runs as root unless explicitly switched
**Severity:** Medium  **CWE-250** (Execution with Unnecessary Privileges)

(Inferred — file not opened above; please verify.) Multi-stage Node images often default to root. Add:

```dockerfile
USER node
```
in the runtime stage and `--chown=node:node` on `COPY` lines.

---

## Low

### S-L1 — `console.log` / `console.warn` in `main.ts` bypasses Pino redaction (S-H3)
`packages/server/src/main.ts` uses `console` directly. Inherits no redact rules. Switch to a child Pino logger.

### S-L2 — `tenant id` allows leading hyphen-like characters
Regex `/^[a-z0-9]…/` is OK; nitpick: 1-character tenant ids pass (`min(1)` at http.ts:110). One-char ids amplify S-C1 (tenant `p` matches every `novamem_p_…` collection).

### S-L3 — `MAX_CONTENT_BYTES = 256 KB` per remember; `bodyLimit = 2 MB` per request
Mismatch is fine but means ~7× headroom. Tighten `bodyLimit` to 512 KB on the data plane, raise only on bulk-import endpoints (none today).

### S-L4 — Embedding endpoint is operator-supplied, not user-supplied
`packages/server/src/embeddings.ts` and `config.ts:54`: `endpoint` comes from env (`NOVAMEM_EMBEDDINGS_ENDPOINT`). Not SSRF — operator controls it. *But* if the dashboard ever exposes this to admins to set, validate against an allow-list (no `localhost`, `169.254.*`, `metadata.google.internal`).

### S-L5 — `qdrant` and `falkordb` containers have no auth configured
Out of scope for the app, but operators should configure qdrant API key (`QDRANT__SERVICE__API_KEY`) and FalkorDB AUTH; `/docker-compose.yaml` does not show either set. Document in README.

### S-L6 — `lucide-react` version not pinned in admin-ui (assumed)
Not opened, but standard practice: pin all UI deps with explicit versions, audit weekly with `pnpm audit --prod`.

---

## Project-isolation walk (the new model)

The shared-project-spans-tenant rule is **mostly** correctly implemented:

| Path | Bearer-project enforced | Project = access boundary | Notes |
|---|---|---|---|
| `POST /v1/me/tokens` (mint) | n/a | ✓ membership checked | http.ts:682 |
| `auth hook` resolveTenantToken | n/a | ✓ token row has project_id | http.ts:343-349 |
| `resolveRequestProject` | ✓ rejects mismatch | n/a | http.ts:426-449 |
| `engine.search` → `ftsSearch` | n/a | ✓ project_id only when set | warm-store:798-806 |
| `engine.search` → `cold.search` | n/a | ✓ collection-segregated | cold-store:45-48 |
| `engine.remember` | n/a | ✓ project_id stamped | engine:97-125 |
| `engine.neighbors` | n/a | ✓ getEntry({projectId}) seed | engine:342-372 |
| `engine.recent` | n/a | ✓ project_id only | engine:303-326 |
| `engine.forget` warm DELETE | n/a | **✗ filters by tenant_id** (S-H2) | engine:390-396 |
| `engine.forget` graph removeNode | n/a | **✗ filters by tenant** (S-H2) | engine:399 / graph-store:75-80 |
| `engine.forget` cold delete | n/a | ✓ collection by project | cold-store:114-124 |
| `addRelation` | n/a | **✗ tenant_id is bearer's** (S-H7) | warm-store:916-931 |
| `removeProjectMember` | n/a | **✗ no token revoke** (S-C2) | warm-store:694-700 |
| `getEntry` | n/a | ✓ project_id wins | warm-store:847-864 (modulo "*" — S-C4) |

The conceptual model is right. The exceptions above are bugs in the implementation of the model, not flaws in the model itself.

---

## OWASP Top 10 (2021) coverage

- **A01 Broken access control:** S-C1, S-C2, S-C4, S-H1, S-H2, S-H7. Project-scope path is correct in 11 of 14 surfaces; 3 forget/relate paths are wrong.
- **A02 Cryptographic failures:** S-M1, S-M3 (bcrypt cost / lib). Token entropy (`randomBytes(32)` → base64url) is solid (256 bits). sha256 hash storage of tokens is correct. TLS termination is the operator's responsibility — README should call it out.
- **A03 Injection:** S-H8 — no SQLi today (parameter binding throughout, including `recent`'s string-built query) but the regex-replace and missing ISO check are quality-of-implementation tripwires.
- **A04 Insecure design:** project model is sound; admin trust model is implicit (an admin can create tenant `p`, see S-C1). Tighten admin actions with audit (S-H9) and require step-up auth (re-enter password) for irreversible operations.
- **A05 Security misconfiguration:** S-M5 (Postgres exposed), S-M11 (root container), S-H4 (CORS+CSP), S-L5 (qdrant/falkor no auth).
- **A06 Vulnerable & outdated components:** S-M3 (bcryptjs unmaintained). `pnpm audit` should be wired into CI.
- **A07 Identification & auth failures:** S-C3 (no per-user throttle), S-M2 (timing leak), S-M9 (no reset), S-H5 (no GC), S-H6 (env-var bootstrap).
- **A08 Software & data integrity:** Dockerfile + lockfile look pinned; no SBOM, no signed images, no SLSA. Defer to a future hardening pass.
- **A09 Logging & monitoring:** S-H3 (no redact), S-H9 (no audit), S-M8 (health leaks), S-L1 (console bypass).
- **A10 SSRF:** S-L4 — embedding endpoint operator-controlled today; tag for future when dashboard exposes it.

---

## Recommended remediation order

1. **S-C1** tenant id validation + audit existing tenants (1 hour)
2. **S-C2** revoke project tokens on member removal (1 hour, transactional)
3. **S-H2** forget by project_id when project-scoped (2 hours, includes tests)
4. **S-H7** addRelation scope by project_id (1 hour)
5. **S-C4** delete the "*" bypass (15 min)
6. **S-H1** SSE bearer match (30 min)
7. **S-H3** Pino redact (15 min)
8. **S-C3** login throttle by username (2 hours)
9. **S-H5** session GC + sliding TTL (2 hours)
10. **S-H4** cookie-based session + CSRF + CORS allow-list (1 day)
11. **S-H9** audit log table + handler instrumentation (1 day)
12. The rest: as part of the next hardening sprint.
