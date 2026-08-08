/**
 * Query decomposition + coherence rerank — arch-plan Phase 4.
 *
 * Single LLM call rewrites a complex user question into ≤N parallel
 * sub-queries, each targeting a distinct information need. Returns the
 * sub-queries (the engine retrieves per sub-query and unions). A second
 * LLM call (optional, gated by config) reranks the unified candidate
 * list for cross-memory coherence — the Exabase Mneme pattern: the
 * final top-k should be internally consistent, not just individually
 * relevant.
 *
 * Borrowed from Exabase Mneme M-1's three-stage pipeline.
 */

import { chatCompletionsURL } from "./endpoint-url.js";
export interface QueryDecomposerConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  maxSubqueries: number;
  coherenceRerank: boolean;
  timeoutMs: number;
}

const DECOMP_PROMPT = (q: string, max: number) => `Rewrite this question into AT MOST ${max} short search queries that together cover all information needed to answer it. Each sub-query should target one distinct fact or relationship. Output ONLY a JSON array of strings.

Question: ${q}

Examples:
"How many items of clothing do I need to pick up or return?" → ["items the user needs to pick up","items the user needs to return","pending clothing items at stores"]
"What did I order last Tuesday?" → ["user order Tuesday"]
"When did I last visit a museum?" → ["user museum visit","last museum date"]

Output JSON array only, no prose:`;

const COHERENCE_PROMPT = (q: string, memories: string[]) => `Question: ${q}

Candidate memories (with rank prefix):
${memories.map((m, i) => `${i + 1}. ${m.slice(0, 600)}`).join("\n")}

Re-order these to maximize coherent support for the question. Drop memories that contradict the majority, are unrelated, or duplicate higher-ranked content. Output ONLY a JSON array of the rank numbers (1-indexed) in the new order, e.g. [3,1,4]. No prose:`;

function stripFences(s: string): string {
  return s
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function parseStringArray(raw: string): string[] {
  const s = stripFences(raw);
  const m = s.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseNumberArray(raw: string): number[] {
  const s = stripFences(raw);
  const m = s.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => (typeof x === "number" ? Math.trunc(x) : NaN))
      .filter((n) => Number.isFinite(n) && n >= 1);
  } catch {
    return [];
  }
}

export class QueryDecomposer {
  private readonly cfg: QueryDecomposerConfig;

  constructor(cfg: QueryDecomposerConfig) {
    this.cfg = cfg;
  }

  /** Returns the original query + ≤(maxSubqueries-1) rewritten queries.
   *  Always includes the original verbatim, so a degenerate decomp doesn't
   *  cripple retrieval. Dedupes against the original. */
  async decompose(query: string): Promise<string[]> {
    const orig = query.trim();
    if (!orig) return [];
    const url = chatCompletionsURL(this.cfg.endpoint);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    const body = JSON.stringify({
      model: this.cfg.model,
      messages: [{ role: "user", content: DECOMP_PROMPT(orig, this.cfg.maxSubqueries) }],
      temperature: 0,
      max_tokens: 256,
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    let text = "";
    try {
      const resp = await fetch(url, { method: "POST", headers, body, signal: ac.signal });
      if (!resp.ok) return [orig];
      const obj = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      text = obj.choices?.[0]?.message?.content ?? "";
    } catch {
      return [orig];
    } finally {
      clearTimeout(timer);
    }
    const sub = parseStringArray(text);
    const all = [orig, ...sub];
    const dedup: string[] = [];
    const seen = new Set<string>();
    for (const q of all) {
      const k = q.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      dedup.push(q);
      if (dedup.length >= this.cfg.maxSubqueries + 1) break;
    }
    return dedup;
  }

  /** Coherence rerank. Returns a permutation of the input as a new order
   *  of indexes (0-based for the engine). Items missing from the model's
   *  response are appended in original order at the end (stable fallback).
   *  Disabled by default unless config.coherenceRerank=true. */
  async coherenceRerank(query: string, candidates: string[]): Promise<number[] | null> {
    if (!this.cfg.coherenceRerank || candidates.length < 2) return null;
    const url = chatCompletionsURL(this.cfg.endpoint);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    const body = JSON.stringify({
      model: this.cfg.model,
      messages: [{ role: "user", content: COHERENCE_PROMPT(query, candidates) }],
      temperature: 0,
      max_tokens: 200,
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    let text = "";
    try {
      const resp = await fetch(url, { method: "POST", headers, body, signal: ac.signal });
      if (!resp.ok) return null;
      const obj = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      text = obj.choices?.[0]?.message?.content ?? "";
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
    const ranks = parseNumberArray(text); // 1-indexed from the prompt
    if (ranks.length === 0) return null;
    const order: number[] = [];
    const seen = new Set<number>();
    for (const r of ranks) {
      const idx = r - 1;
      if (idx >= 0 && idx < candidates.length && !seen.has(idx)) {
        order.push(idx);
        seen.add(idx);
      }
    }
    // Append any missing originals at the end in their original order.
    for (let i = 0; i < candidates.length; i++) {
      if (!seen.has(i)) order.push(i);
    }
    return order;
  }
}

export const __test = { parseStringArray, parseNumberArray };
