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

export interface EmbeddingsConfig {
  provider: "openai-compatible" | "local-transformers";
  endpoint?: string;
  model?: string;
  apiKey?: string;
  /** Vector dimensionality. Must match cold-store collection size. */
  dimensions: number;
}

export interface Embedder {
  embed(input: string | string[]): Promise<number[][]>;
  readonly dimensions: number;
}

class OpenAICompatibleEmbedder implements Embedder {
  readonly dimensions: number;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey?: string;

  constructor(cfg: EmbeddingsConfig) {
    if (!cfg.endpoint) throw new Error("openai-compatible embeddings require endpoint");
    if (!cfg.model) throw new Error("openai-compatible embeddings require model");
    this.endpoint = cfg.endpoint.replace(/\/$/, "");
    this.model = cfg.model;
    this.apiKey = cfg.apiKey;
    this.dimensions = cfg.dimensions;
  }

  async embed(input: string | string[]): Promise<number[][]> {
    const body = JSON.stringify({ input, model: this.model });
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const r = await fetch(`${this.endpoint}/embeddings`, { method: "POST", headers, body });
    if (!r.ok) throw new Error(`embeddings http ${r.status}: ${await r.text()}`);
    const j = (await r.json()) as { data: Array<{ embedding: number[] }> };
    return j.data.map((d) => d.embedding);
  }
}

class LocalTransformersEmbedder implements Embedder {
  readonly dimensions: number;
  private model: string;
  private pipelinePromise: Promise<unknown> | null = null;

  constructor(cfg: EmbeddingsConfig) {
    this.model = cfg.model ?? "Xenova/all-MiniLM-L6-v2";
    this.dimensions = cfg.dimensions;
  }

  private async getPipeline() {
    if (!this.pipelinePromise) {
      // Lazy + dynamic — `@xenova/transformers` is an optional peer dep so
      // operators who don't want local embeddings don't have to install it.
      this.pipelinePromise = (
        import(/* @vite-ignore */ "@xenova/transformers" as string) as Promise<{
          pipeline: (task: string, model: string) => Promise<unknown>;
        }>
      ).then((mod) => mod.pipeline("feature-extraction", this.model));
    }
    return this.pipelinePromise;
  }

  async embed(input: string | string[]): Promise<number[][]> {
    const pipe = (await this.getPipeline()) as (
      arr: string[],
      opts: { pooling: "mean"; normalize: boolean },
    ) => Promise<{ data: Float32Array; dims: number[] }>;
    const arr = Array.isArray(input) ? input : [input];
    const out: number[][] = [];
    for (const text of arr) {
      const r = await pipe([text], { pooling: "mean", normalize: true });
      out.push(Array.from(r.data));
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
