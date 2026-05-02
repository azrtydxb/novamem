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

/** Default session TTL — 24 hours. Refreshed on every request via the
 *  warm-store's `last_seen_at` update; expiresAt is fixed at creation so
 *  long-lived sessions can't accumulate forever without explicit relogin. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

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

/** Seed an initial admin if (a) the users table is empty AND (b) bootstrap
 *  env vars are set. This makes the first deploy work end-to-end without a
 *  manual SQL step — operator sets the env, restarts, lands a working login.
 *  No-ops on subsequent restarts; the env vars are only consulted when there
 *  are zero existing users. Returns the username if it seeded, else null. */
export async function bootstrapAdmin(
  warm: WarmStore,
  username: string | undefined,
  password: string | undefined,
  logger: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<string | null> {
  const existing = await warm.countAdmins();
  if (existing > 0) return null;
  if (!username || !password) {
    logger.warn(
      "[novamem] no admin users exist — set NOVAMEM_BOOTSTRAP_ADMIN_USERNAME + " +
        "NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD on first start to seed one. The dashboard " +
        "will refuse logins until at least one admin is created.",
    );
    return null;
  }
  const hash = await hashPassword(password);
  await warm.createUser({ username, passwordHash: hash, role: "admin", tenantId: null });
  logger.info(
    `[novamem] seeded bootstrap admin user "${username}" — log in at /admin and rotate the password (or env-set a stronger one).`,
  );
  return username;
}
