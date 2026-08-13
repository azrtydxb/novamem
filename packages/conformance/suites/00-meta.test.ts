import { describe, expect, it } from "vitest";
import { api } from "../src/client.js";
import { COVERAGE, EXEMPT } from "../src/coverage.js";

describe("meta endpoints", () => {
  for (const path of ["/health", "/live", "/ready"]) {
    it(`GET ${path} is 200 without auth`, async () => {
      const r = await api(path, { token: "" });
      expect(r.status).toBe(200);
    });
  }

  it("GET /openapi.json serves a valid OpenAPI doc", async () => {
    const r = await api<{ openapi: string; paths: Record<string, unknown> }>(
      "/openapi.json", { token: "" });
    expect(r.status).toBe(200);
    expect(r.body.openapi).toMatch(/^3\./);
    expect(Object.keys(r.body.paths).length).toBeGreaterThan(20);
  });

  it("every live endpoint is claimed by a suite (coverage gate)", async () => {
    const r = await api<{ paths: Record<string, Record<string, unknown>> }>(
      "/openapi.json", { token: "" });
    const live = Object.entries(r.body.paths).flatMap(([p, methods]) =>
      Object.keys(methods).map((m) => `${m.toUpperCase()} ${p}`));
    const claimed = new Set([...Object.keys(COVERAGE), ...Object.keys(EXEMPT)]);
    const unclaimed = live.filter((e) => !claimed.has(e));
    expect(unclaimed, `unclaimed endpoints:\n${unclaimed.join("\n")}`).toEqual([]);
  });
});
