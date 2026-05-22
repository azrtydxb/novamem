/**
 * Write-time LLM fact extraction — arch-plan Phase 2.
 *
 * Distills a raw conversational chunk into typed facts (preference / fact /
 * event / task / knowledge). Each fact becomes its own memory entry with
 * metadata.fact = {...} and metadata.source_chunk_id back-pointing to the
 * raw chunk, so the answerer can read pre-digested propositions while the
 * raw text remains addressable as supporting context.
 *
 * Borrowed from Mem0's April 2026 token-efficient algorithm: ADD-only at
 * write time, no UPDATE/DELETE. Recency + temporal scoring at read time
 * resolves contradictions. Avoids cascading-update bugs and shrinks the
 * write-side LLM cost to one call per chunk.
 */

export type FactType = "preference" | "fact" | "event" | "task" | "knowledge";

export interface ExtractedFact {
  type: FactType;
  subject: string;
  predicate: string;
  object: string;
  occurredAt?: string;
  entities: string[];
  importance: number; // 1..5
}

export interface FactExtractorConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  maxFactsPerChunk: number;
  timeoutMs: number;
}

const SYSTEM_PROMPT = `You distill conversational text into typed memory facts. You output ONLY a JSON array.

Each fact MUST have these fields exactly:
  "type": one of "preference" | "fact" | "event" | "task" | "knowledge"
  "subject": who/what the fact is about ("the user", a named person, an entity)
  "predicate": short verb-phrase ("prefers", "located_in", "did", "owns", "wants")
  "object": the value (free text, concise)
  "occurredAt": ISO-8601 timestamp if the fact has a clear time, else omit
  "entities": array of proper nouns, places, dollar amounts, counts mentioned
  "importance": 1..5 (5 = critical for recall)

Type meanings:
  preference: stable likes/dislikes/habits
  fact:       static personal info (degree, name, address)
  event:      something that happened with a time
  task:       open todo / pending action
  knowledge:  user's situation/status that may change (location, job)

Rules:
- Only emit facts that are clearly supported by the text. If unsure, skip.
- Skip "the user is asking" / pleasantries / assistant suggestions.
- Use the conversation's date metadata for occurredAt when relevant.
- Output an empty array [] if no facts can be extracted.`;

const USER_PROMPT_TEMPLATE = (content: string, max: number) => `Extract up to ${max} typed facts from this conversation chunk:

\`\`\`
${content}
\`\`\`

Output ONLY a JSON array of fact objects. No prose, no explanation, no markdown.`;

function stripCodeFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function parseFacts(raw: string, max: number): ExtractedFact[] {
  // Strip <think> blocks and code fences before parsing.
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  s = stripCodeFences(s);
  // Find the first JSON array in the response.
  const match = s.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: ExtractedFact[] = [];
  for (const f of arr) {
    if (typeof f !== "object" || f === null) continue;
    const o = f as Record<string, unknown>;
    const type = typeof o.type === "string" ? o.type.toLowerCase().trim() : "";
    if (!["preference", "fact", "event", "task", "knowledge"].includes(type)) continue;
    const subject = typeof o.subject === "string" ? o.subject.trim() : "";
    const predicate = typeof o.predicate === "string" ? o.predicate.trim() : "";
    const object = typeof o.object === "string" ? o.object.trim() : "";
    if (!subject || !predicate || !object) continue;
    const entities = Array.isArray(o.entities)
      ? o.entities.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean)
      : [];
    const importance = typeof o.importance === "number"
      ? Math.max(1, Math.min(5, Math.round(o.importance)))
      : 3;
    const occurredAt = typeof o.occurredAt === "string" ? o.occurredAt.trim() : undefined;
    out.push({
      type: type as FactType,
      subject,
      predicate,
      object,
      occurredAt,
      entities,
      importance,
    });
    if (out.length >= max) break;
  }
  return out;
}

/** Render a fact as a one-line natural language string, suitable for
 *  embedding and FTS indexing. */
export function factToText(f: ExtractedFact): string {
  const time = f.occurredAt ? ` (${f.occurredAt})` : "";
  return `[${f.type}] ${f.subject} ${f.predicate} ${f.object}${time}`;
}

export class FactExtractor {
  private readonly cfg: FactExtractorConfig;

  constructor(cfg: FactExtractorConfig) {
    this.cfg = cfg;
  }

  async extract(content: string): Promise<ExtractedFact[]> {
    if (!content.trim()) return [];
    const url = this.cfg.endpoint.replace(/\/+$/, "") + "/chat/completions";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    const body = JSON.stringify({
      model: this.cfg.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: USER_PROMPT_TEMPLATE(content, this.cfg.maxFactsPerChunk) },
      ],
      temperature: 0,
      max_tokens: 1024,
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    let text = "";
    try {
      const resp = await fetch(url, { method: "POST", headers, body, signal: ac.signal });
      if (!resp.ok) return [];
      const obj = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      text = obj.choices?.[0]?.message?.content ?? "";
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
    return parseFacts(text, this.cfg.maxFactsPerChunk);
  }
}

// Re-export the parser for unit tests.
export const __test = { parseFacts };
