import { describe, it, expect } from "vitest";
import {
  deepSet,
  deepGet,
  parseJsonLoose,
  stringifyJson,
  parseTomlLoose,
  stringifyToml,
  isPlainObject,
} from "../src/merge.js";

describe("deepSet / deepGet", () => {
  it("creates intermediate objects on set", () => {
    const o: Record<string, unknown> = {};
    deepSet(o, ["a", "b", "c"], 42);
    expect(o).toEqual({ a: { b: { c: 42 } } });
  });
  it("preserves siblings when overwriting a deep key", () => {
    const o: Record<string, unknown> = { a: { b: { x: 1 }, sib: 2 } };
    deepSet(o, ["a", "b", "x"], 99);
    expect(o).toEqual({ a: { b: { x: 99 }, sib: 2 } });
  });
  it("replaces non-object intermediates with a fresh object", () => {
    const o: Record<string, unknown> = { a: "scalar" };
    deepSet(o, ["a", "b"], 1);
    expect(o).toEqual({ a: { b: 1 } });
  });
  it("deepGet returns undefined for missing path", () => {
    expect(deepGet({ a: 1 }, ["a", "b"])).toBeUndefined();
  });
  it("deepGet returns existing value", () => {
    expect(deepGet({ a: { b: 5 } }, ["a", "b"])).toBe(5);
  });
});

describe("parseJsonLoose / stringifyJson", () => {
  it("returns {} for null/empty/invalid input", () => {
    expect(parseJsonLoose(null)).toEqual({});
    expect(parseJsonLoose("")).toEqual({});
    expect(parseJsonLoose("   ")).toEqual({});
    expect(parseJsonLoose("not json")).toEqual({});
  });
  it("returns {} for non-object JSON", () => {
    expect(parseJsonLoose("[1,2]")).toEqual({});
    expect(parseJsonLoose('"a string"')).toEqual({});
  });
  it("round-trips an object", () => {
    const o = { a: 1, b: { c: "d" } };
    expect(parseJsonLoose(stringifyJson(o))).toEqual(o);
  });
});

describe("parseTomlLoose / stringifyToml", () => {
  it("returns {} for null/empty/invalid input", () => {
    expect(parseTomlLoose(null)).toEqual({});
    expect(parseTomlLoose("")).toEqual({});
    expect(parseTomlLoose("not = valid = toml")).toEqual({});
  });
  it("round-trips a nested object", () => {
    const o: Record<string, unknown> = { mcp_servers: { novamem: { url: "http://x", transport: "sse" } } };
    const round = parseTomlLoose(stringifyToml(o));
    expect(round).toEqual(o);
  });
});

describe("isPlainObject", () => {
  it("recognises plain objects only", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject("s")).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
  });
});
