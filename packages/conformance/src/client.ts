import { Agent, fetch } from "undici";
import { env } from "./env.js";

const RUN = `conf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;
export const ns = (): string => `${RUN}-${++seq}`;

// Node's built-in fetch (undici) defaults `headersTimeout`/`bodyTimeout` to
// 300_000ms — shorter than a real POST /v1/dream-cycle run against the
// live oracle can take (observed 346816ms / ~5m47s: it walks up to 5000
// warm entries and judges fact clusters through a real LLM). Without this,
// the *client* aborts with UND_ERR_HEADERS_TIMEOUT well before the server
// would have answered, independent of vitest's own per-test timeout. A
// single generous dispatcher for every call in this package is simplest
// and harmless — it only raises a ceiling, it never slows down a fast call.
const dispatcher = new Agent({ headersTimeout: 660_000, bodyTimeout: 660_000 });

export interface ApiResult<T> { status: number; body: T; headers: Headers }

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  const token = opts.token ?? env.testToken;
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const r = await fetch(`${env.url}${path}`, {
    method,
    // undici's own fetch takes its own Agent directly — mixing the
    // package's Agent into Node's bundled-undici global fetch is
    // version-fragile.
    dispatcher,
    headers: {
      // Only set content-type when there's actually a JSON body to
      // describe. Fastify's default JSON body parser treats a
      // Content-Type: application/json request with an empty body as a
      // parse error (400 "Body cannot be empty...") rather than "no
      // body" — bodyless operator routes like POST /v1/dream-cycle and
      // POST /v1/reap-orphans have no `body` schema at all, so sending
      // this header on those unauthenticated auth-gate probes masked the
      // real 401 behind a spurious 400.
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON stays string */ }
  return { status: r.status, body: body as T, headers: r.headers };
}

export const adminApi = <T = unknown>(path: string, opts: Parameters<typeof api>[1] = {}) =>
  api<T>(path, { ...opts, token: env.adminToken });

/** Session-cookie admin auth. Some routes (decay/dream-cycle/reap-orphans/
 *  observe, in `user` auth mode) gate on a Better-Auth session
 *  (`req.dashUser`) rather than any bearer token — see `env.adminCookie`'s
 *  doc comment. `token: ""` suppresses the default bearer header so the
 *  request is cookie-only, matching how a dashboard browser session would
 *  authenticate. */
let cookiePromise: Promise<string> | null = null;

/** Resolve the admin session cookie: the NOVAMEM_ADMIN_COOKIE env wins;
 *  otherwise sign in once with NOVAMEM_ADMIN_EMAIL/PASSWORD and cache the
 *  set-cookie for the whole run (env.ts promised this; it was previously
 *  unimplemented and cookie-gated suites 401'd unless the operator minted
 *  a cookie by hand). */
export async function adminCookie(): Promise<string> {
  if (env.adminCookie) return env.adminCookie;
  if (!env.adminEmail || !env.adminPassword) {
    throw new Error(
      "conformance: cookie-gated route needs NOVAMEM_ADMIN_COOKIE or NOVAMEM_ADMIN_EMAIL+NOVAMEM_ADMIN_PASSWORD",
    );
  }
  cookiePromise ??= (async () => {
    // `signInRaw` sends the matching Origin (undici sends `Origin: null`
    // on POST, which Better Auth's trusted-origin check rejects outright)
    // and waits out Better Auth's own 3-per-10s sign-in throttle.
    const r = await signInRaw(env.adminEmail, env.adminPassword);
    if (r.status !== 200) {
      cookiePromise = null; // allow retry on transient failure
      throw new Error(`conformance: admin sign-in failed (${r.status})`);
    }
    const cookie = cookieHeaderFrom(r);
    if (!cookie) throw new Error("conformance: sign-in returned no set-cookie");
    return cookie;
  })();
  return cookiePromise;
}

/** Join a response's `set-cookie` list into a `Cookie:` request header,
 *  applying browser semantics: last value wins per name, and an empty
 *  value (`name=; Max-Age=0`) is a DELETION, not a cookie worth sending.
 *  Both matter for `/api/auth/admin/impersonate-user`, whose response
 *  clears `nm.session_token` and then re-sets it in the same reply — a
 *  naive join sends the cleared one first and the session resolves to
 *  null. */
export const cookieHeaderFrom = (r: ApiResult<unknown>): string => {
  const jar = new Map<string, string>();
  for (const raw of r.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "") jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
};

/** Better Auth ships its OWN per-IP limiter in front of `/sign-in/email`
 *  (3 requests per 10s window, on top of novamem's per-account 5-strike
 *  limiter). A suite that mints several sessions trips it in seconds —
 *  and it is a genuine 429, not a credential failure, so the right
 *  response is to wait out the window rather than fail the test. The
 *  message is BA's; novamem's own limiter answers `{error, retryAfter}`
 *  and must NOT be retried away. */
const BA_THROTTLE = "Too many requests. Please try again later.";
const isBaThrottle = (r: ApiResult<unknown>): boolean =>
  r.status === 429 && (r.body as { message?: string } | null)?.message === BA_THROTTLE;

export async function signInRaw(email: string, password: string): Promise<ApiResult<unknown>> {
  let r!: ApiResult<unknown>;
  for (let attempt = 0; attempt < 5; attempt++) {
    r = await api<unknown>("/api/auth/sign-in/email", {
      body: { email, password },
      token: "",
      headers: env.origin ? { origin: env.origin } : {},
    });
    if (!isBaThrottle(r)) return r;
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  return r;
}

/** Sign in as an arbitrary account and return its session cookie. Used by
 *  41-better-auth to drive the destructive Better Auth surface (password
 *  change, session revocation, ban) against THROWAWAY users rather than
 *  the shared admin identity every other suite depends on. */
export async function signIn(email: string, password: string): Promise<string> {
  const r = await signInRaw(email, password);
  if (r.status !== 200) {
    throw new Error(
      `conformance: sign-in as ${email} failed (${r.status}) ${JSON.stringify(r.body)}`,
    );
  }
  const cookie = cookieHeaderFrom(r);
  if (!cookie) throw new Error(`conformance: sign-in as ${email} returned no set-cookie`);
  return cookie;
}

/** Same as `api`, but authenticated by an explicit session cookie. */
export const cookieApi = <T = unknown>(
  cookie: string,
  path: string,
  opts: Parameters<typeof api>[1] = {},
): Promise<ApiResult<T>> =>
  api<T>(path, {
    ...opts,
    token: "",
    headers: { cookie, ...(env.origin ? { origin: env.origin } : {}), ...opts.headers },
  });

export const adminCookieApi = async <T = unknown>(
  path: string,
  opts: Parameters<typeof api>[1] = {},
): Promise<ApiResult<T>> =>
  api<T>(path, {
    ...opts,
    token: "",
    headers: { cookie: await adminCookie(), ...opts.headers },
  });
