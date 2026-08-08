/**
 * Reading a chat-completions response, and asking for one that is readable.
 *
 * Every LLM-backed feature here (fact extraction, Mem0-style updation,
 * query decomposition, coherence rerank, the observer) used to read
 * `choices[0].message.content` directly and coalesce a missing value to
 * `""`. Against a *reasoning* model that is not a rare edge case, it is
 * the normal response:
 *
 *   - The chain of thought goes to `message.reasoning`, a sibling field.
 *   - `message.content` is `null` until the model stops reasoning.
 *   - Reasoning is billed against `max_tokens`, so a budget sized for the
 *     answer alone (256 for decomposition, 128 for the ADD/UPDATE/DELETE
 *     decision) is spent before a single content token is emitted, and
 *     the response comes back `finish_reason: "length"` with no content.
 *
 * Observed on nova-bench against `qwen3-6-35b-a3b-nvfp4`: extraction
 * returned `content: null` after 3,558 characters of reasoning, having
 * burned all 1,024 tokens. Because `?? ""` turned that into "no facts
 * found", every one of these features degraded to a silent no-op —
 * configured, enabled, logging nothing, doing nothing.
 *
 * Two defences here:
 *   1. `chatCompletionBody` asks the model not to think, which puts the
 *      answer back in `content` for the models that honour it.
 *   2. `readCompletionText` reports *why* a response was unusable instead
 *      of flattening it to "", so callers can log a real reason. Silence
 *      is what made this expensive to find.
 */

export interface ChatCompletionChoice {
  message?: { content?: string | null; reasoning?: string | null };
  finish_reason?: string;
}

export interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
}

export interface CompletionText {
  /** Usable assistant text, or "" when the response carried none. */
  text: string;
  /** Human-readable reason `text` is empty; undefined when it isn't. */
  emptyReason?: string;
}

/** Request body for an OpenAI-compatible chat completion.
 *
 *  `chat_template_kwargs.enable_thinking: false` is the vLLM/SGLang
 *  convention for suppressing a reasoning model's chain of thought.
 *  Servers that don't recognise it ignore the field, so it is safe to
 *  send unconditionally. */
export function chatCompletionBody(args: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  maxTokens: number;
  temperature?: number;
}): string {
  return JSON.stringify({
    model: args.model,
    messages: args.messages,
    temperature: args.temperature ?? 0,
    max_tokens: args.maxTokens,
    chat_template_kwargs: { enable_thinking: false },
  });
}

/** Extract assistant text, distinguishing "model said nothing useful"
 *  from "model produced only reasoning" and from "budget ran out". */
export function readCompletionText(obj: ChatCompletionResponse | null | undefined): CompletionText {
  const choice = obj?.choices?.[0];
  if (!choice) return { text: "", emptyReason: "response contained no choices" };

  const content = choice.message?.content ?? "";
  if (content.trim()) return { text: content };

  // No content. Say which of the two failure shapes this is, because the
  // fixes differ: a reasoning-only response needs `enable_thinking:false`
  // (or a caller that accepts reasoning), a truncated one needs a bigger
  // budget.
  const reasoning = choice.message?.reasoning ?? "";
  if (reasoning.trim()) {
    return {
      text: "",
      emptyReason:
        `model returned reasoning only (${reasoning.length} chars, ` +
        `finish_reason=${choice.finish_reason ?? "unknown"}) and no content — ` +
        `the endpoint ignored enable_thinking:false; raise max_tokens or use a non-reasoning model`,
    };
  }
  if (choice.finish_reason === "length") {
    return { text: "", emptyReason: "response hit the max_tokens budget before emitting content" };
  }
  return { text: "", emptyReason: `response carried no content (finish_reason=${choice.finish_reason ?? "unknown"})` };
}
