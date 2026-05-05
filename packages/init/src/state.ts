/**
 * Tiny persistent state for the init CLI.
 *
 * On a successful run, write the values the user picked so the next run
 * can pre-fill them. Only stores non-sensitive choices: base URL and
 * email. Bearer tokens are NEVER stored — they're auth material and
 * the user might rotate them between runs.
 *
 * Location: `$XDG_CONFIG_HOME/novamem/init.json` (default
 * `~/.config/novamem/init.json`). Falls back to silent no-op if the
 * directory can't be created (e.g. read-only home).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface InitState {
  /** Last successful `--base-url` value. Pre-fills the next interactive
   *  prompt unless the user passes a flag or has the env var set. */
  lastBaseUrl?: string;
  /** Last email used for `--email` / interactive sign-in. */
  lastEmail?: string;
}

function statePath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "novamem", "init.json");
}

/** Load state from disk. Returns `{}` if missing / unreadable / invalid
 *  — never throws. */
export function loadState(): InitState {
  try {
    const raw = readFileSync(statePath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      const out: InitState = {};
      if (typeof obj.lastBaseUrl === "string") out.lastBaseUrl = obj.lastBaseUrl;
      if (typeof obj.lastEmail === "string") out.lastEmail = obj.lastEmail;
      return out;
    }
    return {};
  } catch {
    return {};
  }
}

/** Save state to disk. Best-effort: creates the directory if it doesn't
 *  exist, swallows errors (read-only home, permission denied, etc.). */
export function saveState(s: InitState): void {
  try {
    const path = statePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  } catch {
    // Best-effort. State is a convenience, not a contract.
  }
}
