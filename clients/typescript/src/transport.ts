import { NovamemError } from "./errors.js";

/** Bounds a single call when no timeout is given. Sized for the slowest
 * operation: capture embeds the content server-side before it answers. */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** Responses larger than this are rejected rather than buffered. */
export const MAX_RESPONSE_BYTES = 8 << 20;

export interface ClientOptions {
  /** The service root, e.g. "https://novamem.example.com". */
  baseUrl: string;
  /** The user's `nm_…` bearer. Never included in an error. */
  token: string;
  /** Bounds each call, even one given no AbortSignal. Default 15 000. */
  timeoutMs?: number;
  /** Injected fetch, for tests and custom agents. Default: global fetch. */
  fetch?: typeof fetch;
}

export interface CallOptions {
  /** Aborting it ends the call with a `canceled` NovamemError. */
  signal?: AbortSignal;
}

interface Request {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  expectBody?: boolean;
  signal?: AbortSignal;
}

/** One function makes every request, so failures are classified once. */
export class Transport {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(o: ClientOptions) {
    const base = (o?.baseUrl ?? "").trim().replace(/\/+$/, "");
    let ok = false;
    try {
      const u = new URL(base);
      ok = (u.protocol === "http:" || u.protocol === "https:") && u.host !== "";
    } catch {
      ok = false;
    }
    // Names the field, never the value: a token pasted into the wrong
    // option must not end up in a log line.
    if (!ok)
      throw new NovamemError({
        op: "config",
        message: "baseUrl is not an absolute http(s) URL",
      });
    if (!(o.token ?? "").trim())
      throw new NovamemError({ op: "config", message: "token is required" });
    this.baseUrl = base;
    this.#token = o.token;
    this.timeoutMs =
      o.timeoutMs && o.timeoutMs > 0 ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.#fetch = o.fetch ?? globalThis.fetch;
  }

  toJSON(): object {
    return {
      baseUrl: this.baseUrl,
      token: "[redacted]",
      timeoutMs: this.timeoutMs,
    };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Transport { baseUrl: '${this.baseUrl}', token: [redacted] }`;
  }

  #redact(s: string): string {
    return s.split(this.#token).join("[redacted]");
  }

  async call(
    op: string,
    method: string,
    path: string,
    r: Request = {}
  ): Promise<any> {
    let url = this.baseUrl + path;
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(r.query ?? {}))
      if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
    if ([...q].length) url += "?" + q.toString();
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.#token}`,
    };
    let body: string | undefined;
    if (r.body !== undefined) {
      body = JSON.stringify(r.body);
      headers["Content-Type"] = "application/json";
    }

    // Every call is bounded, even one given no signal. The timeout and the
    // caller's signal are told apart afterwards: a timeout means "could not
    // look", a cancel means the caller walked away.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    const both = new AbortController();
    const onAbort = () => both.abort();
    timeout.signal.addEventListener("abort", onAbort);
    r.signal?.addEventListener("abort", onAbort);
    if (r.signal?.aborted) both.abort();

    let status = 0;
    let raw: Uint8Array;
    try {
      const res = await this.#follow(url, {
        method,
        headers,
        body,
        signal: both.signal,
      });
      status = res.status;
      raw = await readCapped(res);
    } catch (err) {
      if (r.signal?.aborted)
        throw new NovamemError({ op, message: "canceled", canceled: true });
      if (timeout.signal.aborted)
        throw new NovamemError({
          op,
          message: "timed out",
          unavailable: true,
          retryable: true,
        });
      if (err instanceof TooLarge) {
        throw new NovamemError({
          op,
          statusCode: status,
          message: "response body exceeds 8 MiB",
          unavailable: true,
        });
      }
      const cause =
        (err as any)?.cause?.code ?? (err as any)?.message ?? String(err);
      throw new NovamemError({
        op,
        message: this.#redact(`unreachable: ${cause}`),
        unavailable: true,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      r.signal?.removeEventListener("abort", onAbort);
    }

    const text = new TextDecoder().decode(raw);
    if (status < 200 || status >= 300) throw this.#httpError(op, status, text);
    if (r.expectBody === false) return undefined;
    // A 2xx with no body is not the contract: decoding it into a default
    // would tell a forget caller the delete happened.
    if (!text.trim())
      throw new NovamemError({
        op,
        statusCode: status,
        message: "empty response body",
        unavailable: true,
      });
    try {
      return JSON.parse(text);
    } catch {
      // In practice a proxy's HTML error page: we never reached a working
      // novamem. Not retryable — the same request parses the same way.
      throw new NovamemError({
        op,
        statusCode: status,
        message: "malformed response body",
        unavailable: true,
      });
    }
  }

  /** Follows up to 5 redirects itself, so the bearer never reaches another
   * origin: a cross-origin hop drops Authorization, as Go's http.Client
   * does. 303, and 301/302 after a POST, continue as a bodyless GET. */
  async #follow(
    url: string,
    init: RequestInit & { headers: Record<string, string> }
  ): Promise<Response> {
    let current = url;
    let req = init;
    for (let hops = 0; ; hops++) {
      const res = await this.#fetch(current, { ...req, redirect: "manual" });
      const location = res.headers.get("location");
      if (
        res.status < 300 ||
        res.status >= 400 ||
        res.status === 304 ||
        !location ||
        hops === 5
      )
        return res;
      await res.body?.cancel();
      const next = new URL(location, current);
      const headers = { ...req.headers };
      if (next.origin !== new URL(current).origin) delete headers.Authorization;
      const toGet =
        res.status === 303 ||
        ((res.status === 301 || res.status === 302) && req.method === "POST");
      if (toGet) delete headers["Content-Type"];
      req = {
        ...req,
        headers,
        method: toGet ? "GET" : req.method,
        body: toGet ? undefined : req.body,
      };
      current = next.toString();
    }
  }

  #httpError(op: string, status: number, text: string): NovamemError {
    let message = "";
    let code = "";
    try {
      const p = JSON.parse(text);
      if (p && typeof p === "object" && p.error) {
        message = String(p.error);
        code = p.code ? String(p.code) : "";
      }
    } catch {
      // not JSON: fall through to the raw text
    }
    if (!message) {
      const t = text.trim();
      message = t.length > 256 ? t.slice(0, 256) + "…" : t;
    }
    // The server's message is quoted verbatim; a server echoing the token
    // back would otherwise launder it into the caller's logs.
    message = this.#redact(message);
    code = this.#redact(code);
    const unavailable = status >= 500 || status === 429;
    return new NovamemError({
      op,
      statusCode: status,
      code,
      message,
      unavailable,
      retryable: unavailable,
    });
  }
}

class TooLarge extends Error {}

async function readCapped(res: Response): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
