/**
 * Unit tests for the MCP spec compliance guards. Pure helpers — exercised
 * here without a Fastify instance; the integration test that they're
 * actually wired into the routes lives in mcp-streamable.test.ts /
 * mcp-sse.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { checkOrigin, checkProtocolVersion } from "./mcp-spec-guards.js";

function fakeReq(headers: Record<string, string | undefined>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe("checkOrigin", () => {
  it("passes when no Origin header is present (non-browser client)", () => {
    expect(checkOrigin(fakeReq({}), { allowedOrigins: [] })).toBeNull();
  });

  it("passes when Origin matches the request Host (same-origin)", () => {
    const r = fakeReq({ origin: "https://novamem.example.com", host: "novamem.example.com" });
    expect(checkOrigin(r, { allowedOrigins: [] })).toBeNull();
  });

  it("passes when Origin is in the allowlist", () => {
    const r = fakeReq({ origin: "https://app.example.com", host: "novamem.example.com" });
    expect(
      checkOrigin(r, { allowedOrigins: ["https://app.example.com"] }),
    ).toBeNull();
  });

  it("passes when allowlist is wildcard '*' (operator opt-in)", () => {
    const r = fakeReq({ origin: "https://untrusted.example", host: "novamem.example.com" });
    expect(checkOrigin(r, { allowedOrigins: ["*"] })).toBeNull();
  });

  it("rejects when Origin is set, not same-origin, and not allowlisted", () => {
    const r = fakeReq({ origin: "https://attacker.example", host: "novamem.example.com" });
    const err = checkOrigin(r, { allowedOrigins: ["https://app.example.com"] });
    expect(err).toMatch(/attacker\.example/);
  });

  it("rejects when Origin is malformed", () => {
    const r = fakeReq({ origin: "not-a-url", host: "novamem.example.com" });
    expect(checkOrigin(r, { allowedOrigins: [] })).not.toBeNull();
  });
});

describe("checkProtocolVersion", () => {
  it("passes when MCP-Protocol-Version header is absent", () => {
    expect(checkProtocolVersion(fakeReq({}))).toBeNull();
  });

  it("passes for every version in the supported set", () => {
    for (const v of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
      expect(
        checkProtocolVersion(fakeReq({ "mcp-protocol-version": v })),
      ).toBeNull();
    }
  });

  it("rejects an unknown version with an actionable message", () => {
    const err = checkProtocolVersion(
      fakeReq({ "mcp-protocol-version": "1999-01-01" }),
    );
    expect(err).toMatch(/1999-01-01/);
    expect(err).toMatch(/2025-11-25/); // names a supported version
  });
});
