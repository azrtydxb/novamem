/**
 * Second-pass cross-encoder reranker — Mem0 alignment, Phase 5.
 *
 * EXPERIMENT, behind a flag (config `rerank.enabled` + per-request
 * `rerank: true`). Adopted only if it beats the Phase 4 configuration on
 * answer accuracy at n≥50; otherwise this file and its wiring are
 * deleted, not left dormant (plan §4, process rule 7 — our only prior
 * measurement of a cross-encoder was harmful, and Mem0's evidence is not
 * our workload).
 *
 * Shape: the engine overfetches a candidate pool (poolMultiplier × k),
 * this class scores every (query, document) pair with a cross-encoder
 * service, and the engine re-orders the pool by that score before the
 * existing diversity + token-budget selection runs. Wire format is the
 * Jina/Cohere-compatible `/rerank` contract that vLLM and TEI both
 * serve for models like BAAI/bge-reranker-v2-m3:
 *
 *   POST <endpoint>  {model, query, documents: string[]}
 *   → {results: [{index, relevance_score}, …]}
 */

export interface SearchRerankerConfig {
  /** Full URL of the rerank endpoint (no path is appended). */
  endpoint: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

/** Documents are clipped before shipping: a cross-encoder scores the
 *  pair on its first window anyway, and an unclipped conversation chunk
 *  can be 24KB — pool × that is real bandwidth on every flagged search. */
const MAX_DOC_CHARS = 2000;

interface RerankResponse {
  results?: Array<{ index?: number; relevance_score?: number }>;
}

export class SearchReranker {
  constructor(private readonly cfg: SearchRerankerConfig) {}

  /** Score `documents` against `query`. Returns a score per input index
   *  (missing entries stay undefined so the caller can keep the fused
   *  order for anything the service did not score). Throws on transport
   *  or contract errors — the caller decides that a failed rerank means
   *  "fall back to fused order", not "fail the search". */
  async rerank(query: string, documents: string[]): Promise<Array<number | undefined>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(this.cfg.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.cfg.model,
          query,
          documents: documents.map((d) => d.slice(0, MAX_DOC_CHARS)),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`rerank endpoint ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const body = (await res.json()) as RerankResponse;
      if (!Array.isArray(body.results)) {
        throw new Error("rerank response missing results[]");
      }
      const scores: Array<number | undefined> = new Array(documents.length);
      for (const r of body.results) {
        if (
          typeof r.index === "number" &&
          r.index >= 0 &&
          r.index < documents.length &&
          typeof r.relevance_score === "number"
        ) {
          scores[r.index] = r.relevance_score;
        }
      }
      return scores;
    } finally {
      clearTimeout(timer);
    }
  }
}
