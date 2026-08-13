import { describe, expect, it } from "vitest";
import { api } from "../src/client.js";

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
});
