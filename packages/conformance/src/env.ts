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
