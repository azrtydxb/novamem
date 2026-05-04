/**
 * Sign in to a novamem server with email + password (Better Auth) and
 * mint a long-lived `nm_…` bearer for the caller. Pure fetch; no SDK.
 *
 * The flow:
 *   POST /api/auth/sign-in/email         → session cookie
 *   POST /v1/me/tokens                    (with cookie) → plaintext nm_…
 *
 * The session is discarded immediately after the bearer is minted.
 */

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "AuthError";
  }
}

export interface SignInOptions {
  baseUrl: string;
  email: string;
  password: string;
  fetchImpl?: typeof fetch;
}

export interface MintTokenOptions {
  baseUrl: string;
  sessionCookie: string;
  label?: string;
  fetchImpl?: typeof fetch;
}

/** Probe the server's /health endpoint. Throws AuthError on non-2xx. */
export async function probeHealth(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = trimTrailingSlash(baseUrl) + "/health";
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (e) {
    throw new AuthError(
      `cannot reach ${url} — is the server running? (${(e as Error).message})`,
      0,
    );
  }
  if (!res.ok) {
    throw new AuthError(`health check failed: ${res.status} ${res.statusText}`, res.status);
  }
}

/**
 * Returns the Better Auth session cookie string (the full Set-Cookie value
 * we need to send back on subsequent requests). Throws AuthError on failure.
 */
export async function signIn(opts: SignInOptions): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = trimTrailingSlash(opts.baseUrl) + "/api/auth/sign-in/email";
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: trimTrailingSlash(opts.baseUrl) },
    body: JSON.stringify({ email: opts.email, password: opts.password }),
    redirect: "manual",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Never echo the raw body — Better Auth sometimes echoes the request
    // payload (incl. email) on failure paths, and these messages land in
    // CI stderr (issue #23). Surface only the parsed `error` field, or
    // a length-bounded fallback.
    throw new AuthError(
      `sign-in failed: ${res.status} ${res.statusText}${formatBodyError(body)}`,
      res.status,
    );
  }
  const cookie = extractSessionCookie(res);
  if (!cookie) {
    throw new AuthError("sign-in succeeded but no session cookie was returned", 0);
  }
  return cookie;
}

/**
 * Mints an `nm_…` bearer with the given label. Returns the plaintext token,
 * which is shown once by the server and irrecoverable afterwards.
 */
export async function mintToken(opts: MintTokenOptions): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = trimTrailingSlash(opts.baseUrl) + "/v1/me/tokens";
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: opts.sessionCookie,
      origin: trimTrailingSlash(opts.baseUrl),
    },
    body: JSON.stringify({ label: opts.label ?? "novamem-init" }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Same redaction policy as signIn — never echo the raw body.
    throw new AuthError(
      `token mint failed: ${res.status} ${res.statusText}${formatBodyError(body)}`,
      res.status,
    );
  }
  const json = (await res.json()) as { token?: string; plaintext?: string };
  const plaintext = json.token ?? json.plaintext;
  if (!plaintext || typeof plaintext !== "string") {
    throw new AuthError("token mint succeeded but response did not include plaintext", 0);
  }
  return plaintext;
}

/**
 * Pulls the Better Auth session cookie out of a Response's Set-Cookie
 * headers. We forward the raw `name=value` pair (not the full directive)
 * so the next request's Cookie header is well-formed.
 *
 * Exported for testing.
 */
export function extractSessionCookie(res: Response): string | null {
  // Node's fetch returns multiple Set-Cookie via headers.getSetCookie() on
  // 22+. Older 20.x lacks that; fall back to the raw header.
  const fromGetSetCookie =
    typeof (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
      ? (res.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
      : null;
  const candidates = fromGetSetCookie ?? splitSetCookie(res.headers.get("set-cookie"));
  for (const directive of candidates) {
    const pair = directive.split(";", 1)[0]?.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name === "nm.session_token" || name.endsWith(".session_token") || name === "session_token") {
      return pair;
    }
  }
  return null;
}

function splitSetCookie(raw: string | null): string[] {
  if (!raw) return [];
  // Naive split — Set-Cookie attribute values don't contain commas in
  // any of Better Auth's emitted cookies, and Node's fetch concatenates
  // multiple Set-Cookie with ", " when getSetCookie is unavailable.
  return raw.split(/,(?=[^,]+=)/g).map((s) => s.trim());
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Renders the safe error suffix for an HTTP failure body.
 *
 * Tries to parse JSON and pull the `error` field (Better Auth + our own
 * envelope both use this shape); falls back to "" if the body isn't
 * JSON or has no error string. Truncated to 80 chars so a verbose
 * error message can't dominate CI logs (issue #23).
 *
 * Exported for testing.
 */
export function formatBodyError(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    const err = parsed?.error;
    if (typeof err === "string" && err.length > 0) {
      return ` — ${err.slice(0, 80)}`;
    }
  } catch {
    // Not JSON — fall through to empty (we never echo raw bodies).
  }
  return "";
}
