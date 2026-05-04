/**
 * Idempotent merge helpers for the host config files we touch.
 *
 * We never clobber. The strategy across formats is the same:
 *   1. Read existing file (treat missing/invalid as `{}`)
 *   2. Set only the keys we own (e.g. `mcpServers.novamem`)
 *   3. Write back, preserving formatting where reasonable
 *
 * For JSON we use 2-space indent. For TOML we serialise via smol-toml.
 */

import * as TOML from "smol-toml";

/** Deep-set a single key path into an object, creating intermediate objects. */
export function deepSet(
  target: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  if (path.length === 0) return;
  let cur: Record<string, unknown> = target;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    const next = cur[seg];
    if (!isPlainObject(next)) {
      const replacement: Record<string, unknown> = {};
      cur[seg] = replacement;
      cur = replacement;
    } else {
      cur = next;
    }
  }
  cur[path[path.length - 1]!] = value;
}

/** Get the value at a key path, or undefined if any segment is missing. */
export function deepGet(target: unknown, path: string[]): unknown {
  let cur: unknown = target;
  for (const seg of path) {
    if (!isPlainObject(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Parse JSON tolerantly — returns `{}` for missing/empty/invalid files so
 * the merge step always works against an object root.
 */
export function parseJsonLoose(raw: string | null | undefined): Record<string, unknown> {
  if (!raw || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Serialise a JSON document with 2-space indent + trailing newline. */
export function stringifyJson(doc: unknown): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

/**
 * Parse TOML tolerantly — returns `{}` for missing/invalid files. Codex
 * uses TOML, so this is the only TOML target we have right now.
 */
export function parseTomlLoose(raw: string | null | undefined): Record<string, unknown> {
  if (!raw || raw.trim() === "") return {};
  try {
    const parsed = TOML.parse(raw);
    return isPlainObject(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Serialise to TOML with smol-toml's default formatting + trailing newline. */
export function stringifyToml(doc: Record<string, unknown>): string {
  return TOML.stringify(doc) + "\n";
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}
