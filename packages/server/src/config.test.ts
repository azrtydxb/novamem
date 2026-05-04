import { describe, expect, it } from "vitest";

import { ConfigSchema, loadConfig } from "./config.js";

const baseEnv = {
  NOVAMEM_WARM_URL: "postgres://x@y:5432/z",
  NOVAMEM_COLD_URL: "http://qdrant:6333",
  NOVAMEM_GRAPH_URL: "redis://falkordb:6379",
};

/** Min-length-satisfying cookie secret used in ConfigSchema.parse tests
 *  that exercise the schema directly (not via loadConfig). */
const TEST_COOKIE_SECRET = "x".repeat(32);

describe("config: defaults + env loading", () => {
  it("loads defaults when only required URLs are set", () => {
    const cfg = loadConfig({ ...baseEnv } as NodeJS.ProcessEnv);
    expect(cfg.service.port).toBe(7_778);
    expect(cfg.auth.mode).toBe("none");
    expect(cfg.embeddings.provider).toBe("local-transformers");
    expect(cfg.decay.defaultEffectiveDays).toBe(7);
  });

  it("respects port + rate-limit overrides from env", () => {
    const cfg = loadConfig({
      ...baseEnv,
      NOVAMEM_PORT: "9000",
      NOVAMEM_RATE_LIMIT_PER_MINUTE: "42",
    } as NodeJS.ProcessEnv);
    expect(cfg.service.port).toBe(9_000);
    expect(cfg.service.rateLimitPerMinute).toBe(42);
  });
});

describe("config: auth.bearer requires token", () => {
  it("throws at parse time when bearer mode has no token", () => {
    expect(() =>
      ConfigSchema.parse({
        service: {},
        auth: { mode: "bearer" }, // no token
        warm: { url: baseEnv.NOVAMEM_WARM_URL },
        cold: { url: baseEnv.NOVAMEM_COLD_URL },
        graph: { enabled: true, url: baseEnv.NOVAMEM_GRAPH_URL },
        embeddings: {},
        decay: {},
      }),
    ).toThrow(/auth\.mode = 'bearer'/);
  });

  it("accepts bearer mode when token is set", () => {
    const cfg = ConfigSchema.parse({
      service: {},
      auth: { mode: "bearer", token: "s3cret" },
      warm: { url: baseEnv.NOVAMEM_WARM_URL },
      cold: { url: baseEnv.NOVAMEM_COLD_URL },
      graph: { enabled: true, url: baseEnv.NOVAMEM_GRAPH_URL },
      embeddings: {},
      decay: {},
      cookieSecret: TEST_COOKIE_SECRET,
    });
    expect(cfg.auth.mode).toBe("bearer");
    expect(cfg.auth.token).toBe("s3cret");
  });

  it("none mode never requires a token", () => {
    const cfg = ConfigSchema.parse({
      service: {},
      auth: { mode: "none" },
      warm: { url: baseEnv.NOVAMEM_WARM_URL },
      cold: { url: baseEnv.NOVAMEM_COLD_URL },
      graph: { enabled: true, url: baseEnv.NOVAMEM_GRAPH_URL },
      embeddings: {},
      decay: {},
      cookieSecret: TEST_COOKIE_SECRET,
    });
    expect(cfg.auth.mode).toBe("none");
  });
});

describe("config: admin.dashboard flag", () => {
  it("defaults to enabled when env var unset", () => {
    const cfg = loadConfig({ ...baseEnv } as NodeJS.ProcessEnv);
    expect(cfg.admin.dashboard).toBe(true);
  });

  it("'0' disables the dashboard", () => {
    const cfg = loadConfig({ ...baseEnv, NOVAMEM_ADMIN_DASHBOARD: "0" } as NodeJS.ProcessEnv);
    expect(cfg.admin.dashboard).toBe(false);
  });

  it("'false' / 'no' / 'off' also disable the dashboard", () => {
    for (const v of ["false", "no", "off", "FALSE", "Off"]) {
      const cfg = loadConfig({ ...baseEnv, NOVAMEM_ADMIN_DASHBOARD: v } as NodeJS.ProcessEnv);
      expect(cfg.admin.dashboard, `value=${v}`).toBe(false);
    }
  });

  it("any other value enables the dashboard", () => {
    for (const v of ["1", "true", "yes", "on", "anything-else"]) {
      const cfg = loadConfig({ ...baseEnv, NOVAMEM_ADMIN_DASHBOARD: v } as NodeJS.ProcessEnv);
      expect(cfg.admin.dashboard, `value=${v}`).toBe(true);
    }
  });
});

describe("config: cookie secret (#13)", () => {
  it("refuses to start when auth.mode != none and NOVAMEM_COOKIE_SECRET unset", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NOVAMEM_AUTH_MODE: "user",
      } as NodeJS.ProcessEnv),
    ).toThrow(/NOVAMEM_COOKIE_SECRET/);
  });

  it("refuses to start when auth.mode = bearer and secret unset", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NOVAMEM_AUTH_MODE: "bearer",
        NOVAMEM_AUTH_TOKEN: "t",
      } as NodeJS.ProcessEnv),
    ).toThrow(/NOVAMEM_COOKIE_SECRET/);
  });

  it("accepts a supplied secret in any auth mode", () => {
    const secret = "a".repeat(32);
    const cfg = loadConfig({
      ...baseEnv,
      NOVAMEM_AUTH_MODE: "user",
      NOVAMEM_COOKIE_SECRET: secret,
    } as NodeJS.ProcessEnv);
    expect(cfg.cookieSecret).toBe(secret);
  });

  it("falls back to a dev secret when auth.mode=none", () => {
    const cfg = loadConfig({
      ...baseEnv,
      NOVAMEM_AUTH_MODE: "none",
    } as NodeJS.ProcessEnv);
    expect(typeof cfg.cookieSecret).toBe("string");
    expect(cfg.cookieSecret.length).toBeGreaterThanOrEqual(16);
  });

  it("rejects too-short secrets at the schema layer", () => {
    expect(() =>
      ConfigSchema.parse({
        service: {},
        auth: { mode: "none" },
        warm: { url: baseEnv.NOVAMEM_WARM_URL },
        cold: { url: baseEnv.NOVAMEM_COLD_URL },
        graph: { enabled: false },
        embeddings: {},
        decay: {},
        cookieSecret: "short",
      }),
    ).toThrow();
  });
});

describe("config: graph.enabled requires url", () => {
  it("throws when graph.enabled but graph.url is missing", () => {
    expect(() =>
      ConfigSchema.parse({
        service: {},
        auth: { mode: "none" },
        warm: { url: baseEnv.NOVAMEM_WARM_URL },
        cold: { url: baseEnv.NOVAMEM_COLD_URL },
        graph: { enabled: true }, // no url
        embeddings: {},
        decay: {},
      }),
    ).toThrow(/graph\.enabled/);
  });

  it("allows graph disabled with no url", () => {
    const cfg = ConfigSchema.parse({
      service: {},
      auth: { mode: "none" },
      warm: { url: baseEnv.NOVAMEM_WARM_URL },
      cold: { url: baseEnv.NOVAMEM_COLD_URL },
      graph: { enabled: false },
      embeddings: {},
      decay: {},
      cookieSecret: TEST_COOKIE_SECRET,
    });
    expect(cfg.graph.enabled).toBe(false);
  });
});
