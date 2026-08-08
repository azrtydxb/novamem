/**
 * Pluggable embeddings adapter. Two implementations:
 *
 *   - openai-compatible: any /v1/embeddings endpoint (OpenAI, vLLM, Ollama,
 *     LM Studio, etc.). Operator supplies `endpoint`, `model`, optional `apiKey`.
 *   - local-transformers: runs an embedding model in-process via
 *     `@xenova/transformers`. Zero external deps; default for `docker compose up`.
 *
 * The factory is keyed by `provider` from config.
 */

/** Retrieval models come in two flavours. Symmetric models (MiniLM and
 *  friends) embed a question and a fact into the same space and need no
 *  help. Asymmetric models — the e5 and bge families, which are the
 *  current recommendation for question→fact retrieval — are *trained*
 *  with distinct prefixes on each side, and lose a large chunk of their
 *  accuracy when both sides are embedded identically. The engine now
 *  tells the embedder which side it is embedding so those models can be
 *  driven correctly. */
export type EmbeddingKind = "query" | "document";

export interface EmbeddingPrefixes {
  query: string;
  document: string;
}

/** Known asymmetric-model prefix conventions, keyed by a substring of the
 *  model id. Operators can always override explicitly via
 *  NOVAMEM_EMBEDDINGS_QUERY_PREFIX / _DOCUMENT_PREFIX. */
const MODEL_PREFIX_PRESETS: Array<{ match: RegExp; prefixes: EmbeddingPrefixes }> = [
  // intfloat/e5-*, multilingual-e5-*
  { match: /(^|\/)(multilingual-)?e5-/i, prefixes: { query: "query: ", document: "passage: " } },
  // BAAI/bge-*-en / bge-*-en-v1.5 — only the query side is prefixed.
  // NOTE: bge-m3 deliberately does not match. It is trained without
  // prefixes on either side, unlike the -en/-zh v1.5 line.
  {
    match: /(^|\/)bge-.*-(en|zh)(-v\d+(\.\d+)?)?$/i,
    prefixes: {
      query: "Represent this sentence for searching relevant passages: ",
      document: "",
    },
  },
  // Qwen3-Embedding-* — instruction-aware. The query side takes an
  // "Instruct: <task>\nQuery: <text>" envelope and the document side is
  // bare text. Measured on a LongMemEval slice against
  // Qwen3-Embedding-0.6B, running it *without* this envelope cost
  // 7.6pp Recall@10, 0.086 nDCG@10 and 0.045 MRR — a large, entirely
  // silent loss, since an unmatched model simply gets empty prefixes.
  {
    match: /(^|\/)qwen3-embedding(-|$)/i,
    prefixes: {
      query:
        "Instruct: Given a question or task from a user, retrieve stored memories " +
        "that contain the information needed to answer it\nQuery: ",
      document: "",
    },
  },
];

/** How a model's prefixes were decided. Exposed because "no preset
 *  matched" is indistinguishable at runtime from "this model wants no
 *  prefixes", and the two have very different consequences: an asymmetric
 *  model driven symmetrically loses a large slice of its accuracy with
 *  nothing in the logs to say so. Operators get told at startup. */
export type PrefixSource = "explicit" | "preset" | "none";

export function resolvePrefixesWithSource(
  model: string | undefined,
  explicit?: Partial<EmbeddingPrefixes>,
): { prefixes: EmbeddingPrefixes; source: PrefixSource } {
  if (explicit?.query !== undefined || explicit?.document !== undefined) {
    return {
      prefixes: { query: explicit.query ?? "", document: explicit.document ?? "" },
      source: "explicit",
    };
  }
  if (model) {
    for (const preset of MODEL_PREFIX_PRESETS) {
      if (preset.match.test(model)) return { prefixes: preset.prefixes, source: "preset" };
    }
  }
  return { prefixes: { query: "", document: "" }, source: "none" };
}

export function resolvePrefixes(
  model: string | undefined,
  explicit?: Partial<EmbeddingPrefixes>,
): EmbeddingPrefixes {
  return resolvePrefixesWithSource(model, explicit).prefixes;
}

export interface EmbeddingsConfig {
  provider: "openai-compatible" | "local-transformers";
  endpoint?: string;
  model?: string;
  apiKey?: string;
  /** Vector dimensionality. Must match cold-store collection size. */
  dimensions: number;
  /** Per-request timeout in ms for remote embedders. A hung embeddings
   *  endpoint would otherwise hang every remember/capture/search — the
   *  query is embedded *before* the per-tier degradation fan-out, so
   *  there is no graceful path around it. Default 30s. */
  timeoutMs?: number;
  /** Explicit prefix overrides. When unset, inferred from the model id. */
  queryPrefix?: string;
  documentPrefix?: string;
  /** Last-resort input cap, in characters. Not a policy limit — the
   *  engine's `maxContentChars` is that — but a guarantee that no input
   *  can be *unembeddable*.
   *
   *  A remote provider answers an over-length input with a 4xx, which is
   *  correctly classified non-retryable, which means the entry is stored,
   *  parked with `embedded_at` NULL, and retried by the reconciler
   *  forever without ever succeeding: invisible to vector search
   *  permanently. Truncating is strictly better — the tail is lost either
   *  way, but the head becomes searchable. Set 0 to disable. */
  maxInputChars?: number;
}

/** ~4 chars/token, so this sits under an 8192-token window with room for
 *  text that tokenises worse than average. Models with smaller windows
 *  truncate server-side as they always have; this only exists to stop the
 *  hard failure at the top end. */
export const DEFAULT_MAX_INPUT_CHARS = 24_000;

/** Truncate on a character budget, reporting whether anything was cut so
 *  the caller can say so rather than silently shortening a memory. */
export function capInputs(
  texts: string[],
  maxInputChars: number,
): { texts: string[]; truncated: number } {
  if (maxInputChars <= 0) return { texts, truncated: 0 };
  let truncated = 0;
  const out = texts.map((t) => {
    if (t.length <= maxInputChars) return t;
    truncated += 1;
    return t.slice(0, maxInputChars);
  });
  return { texts: out, truncated };
}

export interface Embedder {
  /** Embed one or more texts. `kind` selects the asymmetric-retrieval
   *  prefix: "document" when storing, "query" when searching. Defaults to
   *  "document" so existing call sites keep their previous behaviour. */
  embed(input: string | string[], kind?: EmbeddingKind): Promise<number[][]>;
  readonly dimensions: number;
  /** Stable identifier of the model producing these vectors. Recorded on
   *  every cold-store point so a model swap is detectable instead of
   *  silently mixing incompatible embedding spaces. */
  readonly modelId: string;
}

/** Bounded exponential backoff for transient embedding failures. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const EMBEDDING_ATTEMPTS = 3;

/** Marks an embedding failure that retrying cannot fix (bad model id, bad
 *  API key, malformed request). Kept as a distinct type so the retry loop
 *  can tell it apart from a network error raised out of the same `catch`. */
class NonRetryableEmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableEmbeddingError";
  }
}

class OpenAICompatibleEmbedder implements Embedder {
  readonly dimensions: number;
  readonly modelId: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly prefixes: EmbeddingPrefixes;
  private readonly maxInputChars: number;

  constructor(cfg: EmbeddingsConfig) {
    if (!cfg.endpoint) throw new Error("openai-compatible embeddings require endpoint");
    if (!cfg.model) throw new Error("openai-compatible embeddings require model");
    this.endpoint = cfg.endpoint.replace(/\/$/, "");
    this.model = cfg.model;
    this.apiKey = cfg.apiKey;
    this.dimensions = cfg.dimensions;
    this.maxInputChars = cfg.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
    this.prefixes = resolvePrefixes(cfg.model, {
      query: cfg.queryPrefix,
      document: cfg.documentPrefix,
    });
    this.modelId = `openai-compatible:${cfg.model}`;
  }

  async embed(input: string | string[], kind: EmbeddingKind = "document"): Promise<number[][]> {
    const prefix = kind === "query" ? this.prefixes.query : this.prefixes.document;
    const raw = (Array.isArray(input) ? input : [input]).map((t) => `${prefix}${t}`);
    const { texts: arr, truncated } = capInputs(raw, this.maxInputChars);
    if (truncated > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[embeddings] truncated ${truncated} input(s) to ${this.maxInputChars} chars for ${this.model}; ` +
          `the tail is not represented in the vector`,
      );
    }
    const body = JSON.stringify({ input: arr, model: this.model });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    // AbortSignal.timeout bounds the whole request. Without it a hung
    // endpoint holds the calling request (and its pg connection) open
    // indefinitely — the engine's per-tier `.catch` degradation only
    // handles *errors*, never hangs.
    let lastErr: unknown;
    for (let attempt = 1; attempt <= EMBEDDING_ATTEMPTS; attempt += 1) {
      try {
        const r = await fetch(`${this.endpoint}/embeddings`, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (r.ok) {
          const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
          return j.data.map((d) => d.embedding);
        }
        const detail = await r.text().catch(() => "");
        const err = new Error(`embeddings http ${r.status}: ${detail}`);
        // 4xx other than 429 is a caller/config problem (bad model name,
        // bad key). Retrying only burns latency — fail fast.
        if (r.status < 500 && r.status !== 429) throw new NonRetryableEmbeddingError(err.message);
        lastErr = err;
      } catch (err) {
        if (err instanceof NonRetryableEmbeddingError) throw err;
        // Network error, DNS failure, or the abort timeout firing.
        lastErr = err;
      }
      if (attempt < EMBEDDING_ATTEMPTS) await sleep(250 * 2 ** (attempt - 1));
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

class LocalTransformersEmbedder implements Embedder {
  readonly dimensions: number;
  readonly modelId: string;
  private model: string;
  private pipelinePromise: Promise<unknown> | null = null;
  private readonly prefixes: EmbeddingPrefixes;

  constructor(cfg: EmbeddingsConfig) {
    this.model = cfg.model ?? "Xenova/all-MiniLM-L6-v2";
    this.dimensions = cfg.dimensions;
    this.prefixes = resolvePrefixes(this.model, {
      query: cfg.queryPrefix,
      document: cfg.documentPrefix,
    });
    this.modelId = `local-transformers:${this.model}`;
  }

  private async getPipeline() {
    if (!this.pipelinePromise) {
      // Lazy + dynamic — `@xenova/transformers` is an optional peer dep so
      // operators who don't want local embeddings don't have to install it.
      // A failed load must not poison the cached promise forever: clear it
      // so the next call retries instead of rejecting from cache.
      const p = (
        import(/* @vite-ignore */ "@xenova/transformers" as string) as Promise<{
          pipeline: (task: string, model: string) => Promise<unknown>;
        }>
      ).then((mod) => mod.pipeline("feature-extraction", this.model));
      this.pipelinePromise = p;
      p.catch(() => {
        if (this.pipelinePromise === p) this.pipelinePromise = null;
      });
    }
    return this.pipelinePromise;
  }

  async embed(input: string | string[], kind: EmbeddingKind = "document"): Promise<number[][]> {
    const pipe = (await this.getPipeline()) as (
      arr: string[],
      opts: { pooling: "mean"; normalize: boolean },
    ) => Promise<{ data: Float32Array; dims: number[] }>;
    const prefix = kind === "query" ? this.prefixes.query : this.prefixes.document;
    const arr = (Array.isArray(input) ? input : [input]).map((t) => `${prefix}${t}`);
    if (arr.length === 0) return [];
    // One batched call instead of N sequential ones. The result is a
    // flat [n × dims] Float32Array; slice it back into per-input rows
    // using the reported dims so a model whose width differs from the
    // configured `dimensions` still splits correctly.
    const r = await pipe(arr, { pooling: "mean", normalize: true });
    const width = r.dims[r.dims.length - 1] ?? this.dimensions;
    const out: number[][] = [];
    for (let i = 0; i < arr.length; i += 1) {
      out.push(Array.from(r.data.slice(i * width, (i + 1) * width)));
    }
    return out;
  }
}

export function makeEmbedder(cfg: EmbeddingsConfig): Embedder {
  switch (cfg.provider) {
    case "openai-compatible":
      return new OpenAICompatibleEmbedder(cfg);
    case "local-transformers":
      return new LocalTransformersEmbedder(cfg);
    default: {
      const _exhaustive: never = cfg.provider;
      throw new Error(`unknown embeddings provider: ${String(_exhaustive)}`);
    }
  }
}
