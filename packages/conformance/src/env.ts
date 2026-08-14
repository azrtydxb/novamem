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
};

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
