import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../src/client.js";
import { env } from "../src/env.js";
import { ErrorBody } from "../src/schemas.js";

/**
 * Admin dashboard (static SPA) surface. Transcription source:
 * `packages/server/src/http.ts` — the `ADMIN_PUBLIC_URLS` auth-hook
 * bypass (`/admin`, `/admin/`, `/admin/index.html`, `/admin/assets/*`)
 * and the `fastifyStatic` mount with its per-route CSP. Read-only.
 *
 * The parity audit (§9.2) called this out as an untested surface: the Go
 * server 404'd `/admin` under a fully green conformance run.
 *
 * MODE GATING. One server run can only be in one mode, so this suite
 * asserts the enabled contract OR the disabled contract, never both.
 * `NOVAMEM_ADMIN_DASHBOARD` (same spelling as the server's own env var)
 * selects it. When unset the suite probes `/admin` once and infers the
 * mode, so a run that forgets the flag still asserts something real
 * rather than going red on configuration.
 *
 * The one assertion that holds in BOTH modes is the important one: a
 * non-allowlisted path under `/admin` is 401, never 404. The auth hook
 * runs before routing, so probing for `/admin/<anything>` must not leak
 * which paths exist — that 401-not-404 ordering is the contract, and it
 * survives the dashboard being switched off entirely.
 */

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join("; ");

const ENTRY_POINTS = ["/admin", "/admin/", "/admin/index.html"] as const;

let enabled = false;

beforeAll(async () => {
  if (env.adminDashboard) {
    enabled = /^(1|true|yes|on)$/i.test(env.adminDashboard);
    return;
  }
  const probe = await api("/admin", { token: "" });
  enabled = probe.status === 200;
});

describe("admin dashboard", () => {
  // Mode-independent: holds whether or not the SPA is mounted.
  it("a non-allowlisted path under /admin is 401, not 404", async () => {
    const r = await api<{ error: string }>("/admin/not-an-allowlisted-path", { token: "" });
    expect(r.status).toBe(401);
    expect(ErrorBody.parse(r.body).error).toBe("unauthorized");
  });

  it("serves the SPA entry points when enabled, 404s them when disabled", async () => {
    for (const path of ENTRY_POINTS) {
      const r = await api<unknown>(path, { token: "" });
      if (!enabled) {
        expect(r.status, `${path} with the dashboard disabled`).toBe(404);
        continue;
      }
      expect(r.status, `${path} with the dashboard enabled`).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/^text\/html/);
      expect(r.headers.get("content-security-policy")).toBe(CSP);
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(typeof r.body).toBe("string");
      expect(r.body as string).toMatch(/<html|<!doctype/i);
    }
  });

  it("serves hashed bundles under /admin/assets/ when enabled, 404s them when disabled", async () => {
    // Discover a real asset from the SPA shell rather than pinning a
    // hashed filename that changes on every UI build.
    const shell = await api<string>("/admin/index.html", { token: "" });
    if (!enabled) {
      expect(shell.status).toBe(404);
      const missing = await api("/admin/assets/index.js", { token: "" });
      expect(missing.status).toBe(404);
      return;
    }
    const asset = /\/admin\/assets\/[A-Za-z0-9._-]+/.exec(String(shell.body))?.[0];
    expect(asset, "index.html should reference at least one /admin/assets/ bundle").toBeTruthy();
    const r = await api<unknown>(asset!, { token: "" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe(CSP);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    // Assets load before login — no credentials were sent above.
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("a missing file under /admin/assets/ is 404 (allowlisted prefix, absent file)", async () => {
    const r = await api("/admin/assets/definitely-not-a-real-bundle-xyz.js", { token: "" });
    expect(r.status).toBe(404);
  });
});
