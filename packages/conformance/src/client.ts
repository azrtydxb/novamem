import { env } from "./env.js";

const RUN = `conf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
let seq = 0;
export const ns = (): string => `${RUN}-${++seq}`;

export interface ApiResult<T> { status: number; body: T; headers: Headers }

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
): Promise<ApiResult<T>> {
  const token = opts.token ?? env.testToken;
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const r = await fetch(`${env.url}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
