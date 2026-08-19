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
  // Session-cookie admin identity. In `user` auth mode the maintenance
  // routes (decay/dream-cycle/reap-orphans/observe) gate on `requireAdmin`,
  // which only ever sees a Better-Auth session (`req.dashUser`) — a
  // data-plane bearer token never populates it (see
  // packages/server/src/http.ts's `wantsDashUser` allowlist, which excludes
  // these routes). `adminCookie` is the `set-cookie` value from a prior
  // `/api/auth/sign-in/email`; `adminEmail`/`adminPassword` let a suite
  // mint a fresh one when the stored cookie has expired.
  adminCookie: process.env.NOVAMEM_ADMIN_COOKIE ?? "",
  adminEmail: process.env.NOVAMEM_ADMIN_EMAIL ?? "",
  adminPassword: process.env.NOVAMEM_ADMIN_PASSWORD ?? "",
  /** Origin header for Better Auth sign-in. BA's trusted-origin check
   *  rejects `Origin: null` — which is exactly what undici's fetch sends
   *  on POST — while a MISSING origin (curl) passes. Must match the
   *  server's NOVAMEM_BASE_URL. */
  origin: process.env.NOVAMEM_ORIGIN ?? "",
  /** An origin that IS on the target's `NOVAMEM_CORS_ORIGINS` allow-list.
   *  Defaults to config.ts's own default (`["http://localhost:5173"]`),
   *  which is what a target that never sets the var actually serves. */
  corsAllowedOrigin:
    process.env.NOVAMEM_CORS_ALLOWED_ORIGIN ?? "http://localhost:5173",
  /** Tri-state mirror of the server's own NOVAMEM_ADMIN_DASHBOARD. One
   *  server run can only be in one mode, so the dashboard suite asserts
   *  the enabled OR the disabled contract, never both. Unset ⇒ the suite
   *  probes `/admin` once and infers the mode (no false red on an
   *  operator who forgot the flag). */
  adminDashboard: process.env.NOVAMEM_ADMIN_DASHBOARD ?? "",
  /** Set to 1 when the target runs the LLM subsystems (fact extraction,
   *  observer, query decomposition). Unset ⇒ 90-llm skips loudly instead
   *  of waiting on facts that will never be derived. */
  llmSubsystems: /^(1|true|yes|on)$/i.test(
    process.env.NOVAMEM_LLM_SUBSYSTEMS ?? ""
  ),
};

/** True when a suite can obtain a Better-Auth admin session — either a
 *  pre-minted cookie or the email/password `client.ts` signs in with.
 *  Suites used to gate on `env.adminCookie` alone, which silently skipped
 *  every cookie-gated test on a run configured with email+password. */
export const hasAdminIdentity = Boolean(
  env.adminCookie || (env.adminEmail && env.adminPassword)
);

/** Returns whether the current test should be SKIPPED, because the live
 *  oracle isn't running in one of the given auth modes. Later suites
 *  exercise mode-specific behavior (e.g. per-user isolation only applies
 *  under "user"); this keeps them opt-in rather than failing hard against
 *  a differently-configured oracle.
 *
 *  Usage: `it.skipIf(skipUnless(["user"]))("...", async () => { ... })`
 */
export function skipUnless(modes: AuthMode[]): boolean {
  return !modes.includes(env.authMode);
}
