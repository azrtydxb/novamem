import { Agent } from "undici";
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
    // @ts-expect-error -- `dispatcher` is undici's fetch extension, not in
    // the standard lib.dom fetch typings that TS resolves `fetch` against.
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
export const adminCookieApi = <T = unknown>(path: string, opts: Parameters<typeof api>[1] = {}) =>
  api<T>(path, {
    ...opts,
    token: "",
    headers: { cookie: env.adminCookie, ...opts.headers },
  });
