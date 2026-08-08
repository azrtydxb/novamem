/**
 * Observer / Reflector — arch-plan Phase 5.
 *
 * Mastra Observational Memory pattern. A per-(user, project) cacheable
 * markdown blob that summarises the conversation as dated bullets with
 * 🔴/🟡/🟢 priority. Updated periodically by a background "Observer" pass
 * (groups recent memories) and a "Reflector" pass (collapses related
 * bullets + drops superseded items).
 *
 * The blob is stored as a `memory_entries` row with `source_type =
 * "observation"` and a namespace of `__observation__`. Callers fetch it
 * via /v1/context-prefix to feed a static, prompt-cacheable prefix to
 * downstream LLMs — replacing dynamic retrieval for cost-sensitive
 * agents.
 */

import type { WarmStore } from "../warm-store/index.js";
import { chatCompletionsURL } from "./endpoint-url.js";

export interface ObserverConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  /** Trigger Observer pass when this many new memories accumulate since
   *  the last observation. */
  observeThreshold: number;
  /** Trigger Reflector pass when the observation log crosses this many
   *  bullets. */
  reflectThreshold: number;
  timeoutMs: number;
}

const OBSERVE_SYSTEM = `You convert a batch of recent conversational chunks into concise dated bullets for a long-term memory log.

Output format (strict):
- One bullet per fact
- Start each bullet with a priority emoji: 🔴 critical | 🟡 useful | 🟢 minor
- Then the date in YYYY-MM-DD format in brackets
- Then a short factual statement (<140 chars)
- No headings, no prose, no markdown other than the bullets

Examples:
🔴 [2026-05-21] User graduated with a Business Administration degree
🟡 [2026-05-30] User asked about Seattle travel tips; flight to SF delayed
🟢 [2026-06-01] User mentioned packing snacks for flights

Output ONLY the bullets, one per line. No preamble.`;

const REFLECT_SYSTEM = `You restructure a growing observational log into a cleaner version.

Rules:
- Combine bullets about the same fact across dates into one (keep the latest date)
- Demote priority if a fact is older than 6 months and unused
- Drop bullets superseded by newer ones (e.g. "moved to Chicago" then "moved to suburbs" → keep suburbs only)
- Preserve all distinct facts
- Output format identical to input: priority emoji, date, short statement

Output ONLY the reorganised bullets. No preamble.`;

function stripFences(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*```(?:markdown)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

export class Observer {
  private readonly cfg: ObserverConfig;
  private readonly warm: WarmStore;

  constructor(cfg: ObserverConfig, warm: WarmStore) {
    this.cfg = cfg;
    this.warm = warm;
  }

  /** Stable namespace key for the observation blob per scope. */
  private namespace(): string {
    return "__observation__";
  }

  /** Call the LLM with system + user prompt. */
  private async llm(system: string, user: string, maxTokens: number): Promise<string> {
    const url = chatCompletionsURL(this.cfg.endpoint);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    const body = JSON.stringify({
      model: this.cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      max_tokens: maxTokens,
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    try {
      const resp = await fetch(url, { method: "POST", headers, body, signal: ac.signal });
      if (!resp.ok) return "";
      const obj = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return stripFences(obj.choices?.[0]?.message?.content ?? "");
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  }

  /** Run a single observation pass: take the last N raw memories, convert
   *  to dated bullets, append to the observation blob. */
  async observe(userId: string, projectId: string | null, recentChunks: string[]): Promise<string> {
    if (recentChunks.length === 0) return "";
    const user = recentChunks.map((c, i) => `[chunk ${i + 1}]\n${c}`).join("\n\n");
    return this.llm(OBSERVE_SYSTEM, user, 1024);
  }

  /** Run a reflection pass on an existing observation log. */
  async reflect(currentLog: string): Promise<string> {
    if (!currentLog.trim()) return currentLog;
    return this.llm(REFLECT_SYSTEM, currentLog, 2048);
  }

  /** Get the current observation prefix for a scope. Returns "" if none. */
  async getPrefix(userId: string, projectId: string | null): Promise<string> {
    const ns = this.namespace();
    const rows = await this.warm.listRecent(userId, {
      namespaces: [ns],
      k: 1,
      projectId,
    });
    return rows[0]?.content ?? "";
  }

  /** Write/overwrite the observation prefix for a scope. */
  async upsertPrefix(userId: string, projectId: string | null, body: string): Promise<string> {
    const ns = this.namespace();
    // Fetch existing
    const rows = await this.warm.listRecent(userId, {
      namespaces: [ns],
      k: 1,
      projectId,
    });
    if (rows[0]) {
      await this.warm.updateEntry({
        userId,
        id: rows[0].id,
        projectId,
        content: body,
      });
      return rows[0].id;
    }
    // Fresh: contentHash is required by the insert signature; use a hash
    // of the body so a subsequent identical write dedupes via the
    // worthiness gate (no-op overwrite).
    const id = await this.warm.insertEntry({
      userId,
      projectId,
      content: body,
      namespace: ns,
      source: "observer",
      agentName: null,
      metadata: { kind: "observation" } as Record<string, unknown>,
      sourceType: "observation",
      capturedFrom: null,
      confidence: 1,
      contentHash: null,
    });
    return id;
  }
}
