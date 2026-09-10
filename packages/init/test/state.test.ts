import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadState, saveState } from "../src/state.js";

describe("init state", () => {
  let dir: string;
  let prevXdg: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "novamem-init-state-"));
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
  });
  afterEach(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadState returns {} when no file exists", () => {
    expect(loadState()).toEqual({});
  });

  it("saveState writes JSON readable by loadState", () => {
    saveState({
      lastBaseUrl: "https://novamem.example.com",
      lastEmail: "a@b.c",
    });
    expect(loadState()).toEqual({
      lastBaseUrl: "https://novamem.example.com",
      lastEmail: "a@b.c",
    });
  });

  it("loadState ignores invalid JSON gracefully", () => {
    mkdirSync(join(dir, "novamem"), { recursive: true });
    writeFileSync(join(dir, "novamem", "init.json"), "not json", {
      mode: 0o600,
    });
    expect(loadState()).toEqual({});
  });

  it("loadState ignores stray fields it doesn't recognise", () => {
    saveState({ lastBaseUrl: "http://x" } as never);
    // Manually inject a stray field to confirm load drops it.
    const path = join(dir, "novamem", "init.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.someThirdPartyKey = "shouldNotLeak";
    writeFileSync(path, JSON.stringify(raw));
    expect(loadState()).toEqual({ lastBaseUrl: "http://x" });
  });

  it("saveState is best-effort — never throws on a read-only path", () => {
    process.env.XDG_CONFIG_HOME = "/this/path/cannot/exist/and/is/not/writable";
    expect(() => saveState({ lastBaseUrl: "http://x" })).not.toThrow();
  });
});
