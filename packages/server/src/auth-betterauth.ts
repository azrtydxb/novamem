/**
 * Better Auth instance — owns the dashboard control plane (login, sessions,
 * password change, JWT issuance for the SPA→backend channel).
 *
 * Scope (May 2026, per operator decision):
 *  - Email + password only — no social/OIDC providers yet
 *  - Issues opaque session cookies (HttpOnly) by default, plus JWTs on
 *    request via `/api/auth/token` for callers that prefer stateless verify
 *  - admin plugin gives us role-based gates without rolling our own
 *
 * Out of scope:
 *  - API keys for non-browser callers (MCP shim, CLI, scripts) — those
 *    keep using our existing `nm_…` opaque tokens (warm-store/user_tokens).
 *    The auth hook in http.ts checks Better Auth first, falls back to
 *    `resolveUserToken` for `nm_…` callers.
 */

import { betterAuth, type BetterAuthOptions } from "better-auth";
import { admin, jwt } from "better-auth/plugins";
import type { Pool } from "pg";

export interface AuthOptions {
  pool: Pool;
  /** Base URL the dashboard is reachable at (used for redirect validation
   *  and the auth handler's URL construction). */
  baseUrl: string;
  /** Trusted origins for CSRF. baseUrl is always included. */
  trustedOrigins?: string[];
  /** Cookie + JWT signing secret. */
  secret: string;
  /** When false, allow non-Secure cookies (k3s LB without TLS, dev). */
  secureCookies: boolean;
}

export type Auth = ReturnType<typeof buildAuth>;

export function buildAuth(opts: AuthOptions) {
  const trusted = new Set([opts.baseUrl, ...(opts.trustedOrigins ?? [])]);
  const config: BetterAuthOptions = {
    appName: "novamem",
    baseURL: opts.baseUrl,
    secret: opts.secret,
    trustedOrigins: [...trusted],
    database: opts.pool,
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      minPasswordLength: 8,
      maxPasswordLength: 256,
      requireEmailVerification: false,
    },
    advanced: {
      cookiePrefix: "nm",
      defaultCookieAttributes: {
        sameSite: "lax",
        secure: opts.secureCookies,
        httpOnly: true,
      },
    },
    session: {
      // 7-day rolling session. Better Auth rotates the cookie when older
      // than `updateAge` so an active user never sees forced re-login.
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    plugins: [
      admin({
        defaultRole: "user",
        adminRoles: ["admin"],
      }),
      jwt({
        jwt: { expirationTime: "15m" },
      }),
    ],
  };
  return betterAuth(config);
}

/** Cookie name on which Better Auth stores the session token. Used by the
 *  fastify auth hook to detect "browser session present" without parsing
 *  every cookie. Better Auth uses `<cookiePrefix>.session_token`. */
export const BETTER_AUTH_SESSION_COOKIE = "nm.session_token";

/** Better Auth's required Postgres schema (camelCase, quoted identifiers).
 *  We embed it in our existing DDL block in warm-store/index.ts so the
 *  tables exist on first boot. Idempotent — Better Auth uses CREATE TABLE
 *  IF NOT EXISTS-style semantics via Kysely under the hood, but we apply
 *  ours up-front so the rest of the app starts faster. */
export const BETTER_AUTH_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "user" (
    id text PRIMARY KEY,
    name text NOT NULL,
    email text NOT NULL UNIQUE,
    "emailVerified" boolean NOT NULL DEFAULT false,
    image text,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now(),
    role text,
    banned boolean,
    "banReason" text,
    "banExpires" timestamptz
  )`,
  `CREATE TABLE IF NOT EXISTS "session" (
    id text PRIMARY KEY,
    "expiresAt" timestamptz NOT NULL,
    token text NOT NULL UNIQUE,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now(),
    "ipAddress" text,
    "userAgent" text,
    "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "impersonatedBy" text
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_user ON "session"("userId")`,
  `CREATE TABLE IF NOT EXISTS "account" (
    id text PRIMARY KEY,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamptz,
    "refreshTokenExpiresAt" timestamptz,
    scope text,
    password text,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_account_user ON "account"("userId")`,
  `CREATE TABLE IF NOT EXISTS "verification" (
    id text PRIMARY KEY,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamptz NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "updatedAt" timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_verification_identifier ON "verification"(identifier)`,
  `CREATE TABLE IF NOT EXISTS "jwks" (
    id text PRIMARY KEY,
    "publicKey" text NOT NULL,
    "privateKey" text NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now()
  )`,
];
