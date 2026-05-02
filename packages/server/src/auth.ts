/**
 * Dashboard auth: bcrypt password hashing, session minting/resolving, and the
 * first-run bootstrap that seeds an initial admin from env vars when the
 * users table is empty.
 *
 * Tenants/agents continue to use bearer tokens for the data-plane API. This
 * module is strictly for the dashboard control plane (login, RBAC).
 */

import bcrypt from "bcryptjs";

import type { WarmStore } from "./warm-store/index.js";

/** Default session TTL — 24 hours from creation, fixed at mint time.
 *  `last_seen_at` is bumped on each authenticated request for activity
 *  visibility, but does NOT extend the expiry — expired sessions are
 *  garbage-collected on a daily sweep (see `gcExpiredSessions`). */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Login throttle: counts failures per username in-memory, doubles the
 *  required delay after each consecutive failure, and locks an account
 *  out for `LOGIN_LOCKOUT_MS` after `LOGIN_LOCKOUT_THRESHOLD` failures.
 *  In-memory by design (no postgres round-trip on the hot login path);
 *  resets on process restart, which is acceptable for a brute-force
 *  defence (an attacker can't keep restarting the server). */
export const LOGIN_LOCKOUT_THRESHOLD = 5;
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const LOGIN_BACKOFF_BASE_MS = 250; // doubled per failure
const LOGIN_BACKOFF_MAX_MS = 4_000;
const LOGIN_FAIL_RING_TTL_MS = LOGIN_LOCKOUT_MS;

interface LoginFailState {
  failures: number;
  lockedUntil: number; // 0 = not locked
  lastFailureAt: number;
}

export class LoginThrottle {
  private readonly map = new Map<string, LoginFailState>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Inspect the throttle state for a username. Call before bcrypt-comparing
   *  the password — if `lockedUntil > now`, refuse without spending CPU. */
  check(username: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const k = username.toLowerCase();
    const s = this.map.get(k);
    const t = this.now();
    if (!s) return { ok: true };
    if (s.lockedUntil > t) return { ok: false, retryAfterMs: s.lockedUntil - t };
    // Clear stale state outside the lockout window so first-time-in-a-while
    // logins aren't throttled.
    if (t - s.lastFailureAt > LOGIN_FAIL_RING_TTL_MS) {
      this.map.delete(k);
      return { ok: true };
    }
    return { ok: true };
  }

  /** Record a failed login. Returns the same shape as `check()` after the
   *  failure is applied (so callers can include `retryAfterMs` in 429s). */
  recordFailure(username: string): { ok: false; retryAfterMs: number } {
    const k = username.toLowerCase();
    const t = this.now();
    const cur = this.map.get(k) ?? { failures: 0, lockedUntil: 0, lastFailureAt: 0 };
    cur.failures += 1;
    cur.lastFailureAt = t;
    if (cur.failures >= LOGIN_LOCKOUT_THRESHOLD) {
      cur.lockedUntil = t + LOGIN_LOCKOUT_MS;
    }
    this.map.set(k, cur);
    if (cur.lockedUntil > t) return { ok: false, retryAfterMs: cur.lockedUntil - t };
    // Progressive backoff: 250ms, 500ms, 1s, 2s, 4s, then lockout.
    const backoff = Math.min(
      LOGIN_BACKOFF_BASE_MS * Math.pow(2, cur.failures - 1),
      LOGIN_BACKOFF_MAX_MS,
    );
    return { ok: false, retryAfterMs: backoff };
  }

  /** Successful login clears the failure ring. */
  recordSuccess(username: string): void {
    this.map.delete(username.toLowerCase());
  }

  /** Test helper. */
  reset(): void {
    this.map.clear();
  }
}

/** bcrypt cost — 10 is the common default. ~50–100ms per hash on modern
 *  CPUs. Plenty for a low-rate admin login. */
const BCRYPT_ROUNDS = 10;

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  if (!plaintext || !hash) return false;
  return bcrypt.compare(plaintext, hash);
}

/** Minimum bootstrap-admin password length. Operators are encouraged to
 *  use `openssl rand -hex 16` or similar; the floor is conservative. */
export const BOOTSTRAP_PASSWORD_MIN_LENGTH = 12;

/** Seed an initial admin if (a) the users table is empty AND (b) bootstrap
 *  env vars are set. This makes the first deploy work end-to-end without a
 *  manual SQL step — operator sets the env, restarts, lands a working login.
 *  No-ops on subsequent restarts; the env vars are only consulted when there
 *  are zero existing users. Returns the username if it seeded, else null.
 *
 *  Side effect (P1-S5 hardening): on success this clears the password env
 *  var from `process.env` so it doesn't sit there for the lifetime of the
 *  process and surface via `docker inspect` / debug dumps. The username
 *  env var stays — it isn't sensitive. */
export async function bootstrapAdmin(
  warm: WarmStore,
  username: string | undefined,
  password: string | undefined,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
  envObj: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const existing = await warm.countAdmins();
  if (existing > 0) {
    // Clear the password env var even when bootstrap was a no-op — it may
    // have been left over from the original deploy.
    if (envObj.NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD) {
      delete envObj.NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD;
    }
    return null;
  }
  if (!username || !password) {
    logger.warn(
      "[novamem] no admin users exist — set NOVAMEM_BOOTSTRAP_ADMIN_USERNAME + " +
        "NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD on first start to seed one. The dashboard " +
        "will refuse logins until at least one admin is created.",
    );
    return null;
  }
  if (password.length < BOOTSTRAP_PASSWORD_MIN_LENGTH) {
    logger.warn(
      `[novamem] NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD must be at least ` +
        `${BOOTSTRAP_PASSWORD_MIN_LENGTH} characters; refusing to seed admin.`,
    );
    return null;
  }
  const hash = await hashPassword(password);
  await warm.createUser({ username, passwordHash: hash, role: "admin", tenantId: null });
  // P1-S5: scrub the password from the environment so `docker inspect`
  // and any debug dump can't recover it for the lifetime of the process.
  if (envObj.NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD) {
    delete envObj.NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD;
  }
  logger.info(
    `[novamem] seeded bootstrap admin user "${username}" — log in at /admin and rotate the password.`,
  );
  return username;
}

/** Garbage-collect expired sessions. Returns the count deleted. Run on a
 *  daily timer in main.ts. Without this, the `sessions` table grows
 *  unbounded — every login adds a row and `expires_at` is fixed at
 *  creation (review finding P1-S4). */
export async function gcExpiredSessions(warm: WarmStore): Promise<number> {
  const r = await warm.pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
  return r.rowCount ?? 0;
}
