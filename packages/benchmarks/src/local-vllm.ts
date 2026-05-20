export interface LocalVllmClientOptions {
  baseUrl: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface LocalVllmClient {
  generate(prompt: string, opts?: { system?: string; maxTokens?: number; temperature?: number }): Promise<string>;
}

function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<mem_thinking>[\s\S]*?<\/mem_thinking>/gi, "")
    .trim();
}

export function createLocalVllmClient(opts: LocalVllmClientOptions): LocalVllmClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  return {
    async generate(prompt, genOpts = {}) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000);
      try {
        const messages = [
          ...(genOpts.system ? [{ role: "system", content: genOpts.system }] : []),
          { role: "user", content: prompt },
        ];
        const response = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({
            model: opts.model,
            messages,
            temperature: genOpts.temperature ?? 0,
            max_tokens: genOpts.maxTokens ?? 512,
          }),
          signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`local vLLM HTTP ${response.status}: ${text.slice(0, 500)}`);
        const parsed = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
        return stripThinking(parsed.choices?.[0]?.message?.content ?? "");
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
