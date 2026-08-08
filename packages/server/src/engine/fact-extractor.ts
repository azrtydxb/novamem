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

import { chatCompletionsURL } from "./endpoint-url.js";
import {
  chatCompletionBody,
  readCompletionText,
  type ChatCompletionResponse,
} from "./llm-response.js";
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
  /** Per-extractor concurrency cap. Bounds how many extract() calls can
   *  be in-flight against the upstream LLM at once. New calls queue on a
   *  semaphore; the upstream queue depth stays bounded even when the
   *  bench ingest fires 100s of fire-and-forget extractions per second.
   *
   *  Without this, fire-and-forget extractions stack faster than the
   *  upstream LLM drains, AbortControllers all fire ~timeoutMs later,
   *  and most extractions silently fail (we observed 97% drop on the
   *  100q ingest with qwen max-num-seqs=10 and no cap here).
   *
   *  Pick a value slightly below upstream's effective concurrency
   *  divided by replica count: e.g., qwen max-num-seqs=10 on 3 pods →
   *  cap=3 (9 total, safely below 10). */
  maxConcurrent: number;
}

const SYSTEM_PROMPT = `You distill conversational text into typed memory facts. You output ONLY a JSON array.

Each fact MUST have these fields exactly:
  "type": one of "preference" | "fact" | "event" | "task" | "knowledge"
  "subject": who/what the fact is about ("the user", a named person, an entity)
  "predicate": short verb-phrase ("prefers", "located_in", "did", "owns", "wants", "ordered", "redeemed", "visited", "pickup_at", "return_at")
  "object": the value (free text, concise)
  "occurredAt": ISO-8601 timestamp if the fact has a clear time. If the chunk header carries a "Date:" line, use that date. Else omit.
  "entities": array of every proper noun, place name, brand, dollar amount, count, location, person referenced. Be exhaustive.
  "importance": 1..5 (5 = critical for recall)

Type meanings:
  preference: stable likes/dislikes/habits — every distinct preference gets its own fact
  fact:       static personal info (degree, name, address, ownership)
  event:      something that happened with a time
  task:       open todo / pending action — every distinct task gets its own fact
  knowledge:  user's situation/status that may change (location, job, plans)

CRITICAL — ENUMERATION:
- Each distinct item, action, person, place, or preference is its OWN fact, not a summary.
- If the user mentions "3 items at the store: blazer, boots, dress", emit THREE separate facts, one per item.
- If the user lists preferences ("I like X, also Y, and Z"), emit ONE fact per preference.
- If the user mentions counts or amounts ("$5 coupon", "2 weeks", "3 items"), include them in entities AND in the object text.
- Prefer many small facts over one summary fact. Aim for 3-6 facts when the chunk has multiple items.

Rules:
- Only emit facts clearly supported by the text. If unsure, skip.
- Skip "the user is asking" / pleasantries / assistant suggestions.
- Always include the chunk's Date in occurredAt when the fact is event/task/knowledge.
- Output an empty array [] if no facts can be extracted.`;

const USER_PROMPT_TEMPLATE = (content: string, max: number) => `Extract up to ${max} typed facts from this conversation chunk. Enumerate every distinct item, action, or preference as its own fact:

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

/** Minimal Promise-based semaphore. acquire() resolves when a slot is
 *  free; release() returns a slot. No queue cancellation — call sites
 *  use AbortController on the actual fetch for that. */
class Semaphore {
  private readonly capacity: number;
  private inFlight = 0;
  private waiters: Array<() => void> = [];
  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }
  async acquire(): Promise<void> {
    if (this.inFlight < this.capacity) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((res) => this.waiters.push(res));
    this.inFlight++;
  }
  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}

export class FactExtractor {
  private readonly cfg: FactExtractorConfig;
  private readonly sem: Semaphore;

  constructor(cfg: FactExtractorConfig) {
    this.cfg = cfg;
    this.sem = new Semaphore(cfg.maxConcurrent);
  }

  async extract(content: string): Promise<ExtractedFact[]> {
    if (!content.trim()) return [];
    await this.sem.acquire();
    try {
      return await this.extractUnlimited(content);
    } finally {
      this.sem.release();
    }
  }

  private async extractUnlimited(content: string): Promise<ExtractedFact[]> {
    const url = chatCompletionsURL(this.cfg.endpoint);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
    };
    if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
    const body = chatCompletionBody({
      model: this.cfg.model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: USER_PROMPT_TEMPLATE(content, this.cfg.maxFactsPerChunk) },
      ],
      maxTokens: 1024,
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
    let text = "";
    try {
      const resp = await fetch(url, { method: "POST", headers, body, signal: ac.signal });
      if (!resp.ok) return [];
      const read = readCompletionText((await resp.json()) as ChatCompletionResponse);
      // An unusable response is not "this chunk had no facts". Throwing
      // routes it to the caller's existing failure log instead of being
      // indistinguishable from a legitimately empty extraction — the
      // exact conflation that let extraction sit inert on nova-bench.
      if (read.emptyReason) throw new Error(`fact extraction: ${read.emptyReason}`);
      text = read.text;
    } finally {
      clearTimeout(timer);
    }
    return parseFacts(text, this.cfg.maxFactsPerChunk);
  }

  /** Arch-plan Phase 2 v2: Mem0 ADD/UPDATE/DELETE/NOOP decision.
   *  Called by the engine for each newly-extracted fact AFTER similar
   *  existing facts have been retrieved. Returns the operation the
   *  caller should apply.
   *
   *  Goes through the same concurrency semaphore as extract() so the
   *  upstream LLM queue depth stays bounded regardless of how many
   *  extractions+updations are in flight. */
  async decideOperation(
    newText: string,
    existing: SimilarExistingFact[],
  ): Promise<UpdationDecision> {
    if (!existing.length) return { op: "ADD" };
    await this.sem.acquire();
    try {
      const url = chatCompletionsURL(this.cfg.endpoint);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
      };
      if (this.cfg.apiKey) headers.authorization = `Bearer ${this.cfg.apiKey}`;
      // 128 tokens was too tight to be reliable even without a reasoning
      // model in the way; with one it could not emit a single content
      // token, so every decision silently fell back to ADD and the
      // supersession path never ran.
      const body = chatCompletionBody({
        model: this.cfg.model,
        messages: [
          { role: "system", content: OP_SYSTEM_PROMPT },
          { role: "user", content: OP_USER_PROMPT(newText, existing) },
        ],
        maxTokens: 256,
      });
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.cfg.timeoutMs);
      try {
        const resp = await fetch(url, { method: "POST", headers, body, signal: ac.signal });
        if (!resp.ok) return { op: "ADD" };
        const read = readCompletionText((await resp.json()) as ChatCompletionResponse);
        // ADD stays the fallback for an unusable response: it is the only
        // option that cannot lose an existing memory.
        if (read.emptyReason) return { op: "ADD" };
        return parseOperation(read.text, new Set(existing.map((e) => e.id)));
      } catch {
        return { op: "ADD" };
      } finally {
        clearTimeout(timer);
      }
    } finally {
      this.sem.release();
    }
  }
}

// ─── Mem0-style updation: ADD/UPDATE/DELETE/NOOP ──────────────────────
//
// For each newly-extracted fact, the engine searches for semantically
// similar existing facts and asks the LLM to decide one of:
//   ADD    — new info, store as a fresh fact
//   UPDATE — same subject+predicate, more or refined info → rewrite the
//            existing fact in place (so the old text doesn't compete
//            with the new at retrieval)
//   DELETE — contradicts an existing fact (e.g. user moved cities) →
//            mark the old one inactive; insert the new one
//   NOOP   — duplicate of an existing fact, bump hits only
//
// This is the single difference between Mem0 v1 (~67% LongMemEval) and
// v2 (93%): write-time dedup/supersede vs uncurated ADD-only. We pay
// one extra LLM call per new fact when the similarity gate fires.

export type FactOperation = "ADD" | "UPDATE" | "DELETE" | "NOOP";

export interface UpdationDecision {
  op: FactOperation;
  targetId?: string;
  reason?: string;
}

export interface SimilarExistingFact {
  id: string;
  text: string;
  /** Optional metadata snapshot for context — type, subject, predicate, etc. */
  factType?: string;
  importance?: number;
}

const OP_SYSTEM_PROMPT = `You compare a NEW memory fact against the most semantically similar EXISTING facts already in the user's memory store, and decide what to do.

Output exactly one JSON object on a single line:
{"op": "ADD"|"UPDATE"|"DELETE"|"NOOP", "targetId": "<id>" | null, "reason": "<one short sentence>"}

Rules:
- ADD: the new fact is genuinely new information; none of the existing facts cover it.
- UPDATE: the new fact REFINES or AUGMENTS one existing fact (same subject + same predicate, but the new fact has more or more-specific info). targetId = that fact's id.
- DELETE: the new fact CONTRADICTS an existing fact (e.g. user moved cities — the old location is no longer true). targetId = the fact to mark obsolete.
- NOOP: the new fact is essentially identical to an existing one. targetId = the duplicate.

When in doubt, prefer ADD over UPDATE, and UPDATE over DELETE. NOOP only for near-identical text.`;

const OP_USER_PROMPT = (newText: string, existing: SimilarExistingFact[]) =>
  `NEW fact:
${newText}

EXISTING similar facts (id then text):
${existing.map((e) => `${e.id}: ${e.text}`).join("\n")}

Decide ADD / UPDATE / DELETE / NOOP. Output ONLY one JSON object:`;

function parseOperation(raw: string, validIds: Set<string>): UpdationDecision {
  let s = (raw || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  s = s.replace(/^\s*```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return { op: "ADD" };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return { op: "ADD" };
  }
  const opRaw = typeof obj.op === "string" ? obj.op.toUpperCase().trim() : "";
  const ops: FactOperation[] = ["ADD", "UPDATE", "DELETE", "NOOP"];
  const op = ops.find((o) => o === opRaw) ?? "ADD";
  const targetId =
    typeof obj.targetId === "string" && validIds.has(obj.targetId)
      ? obj.targetId
      : undefined;
  // Tighten the schema: UPDATE / DELETE / NOOP require a real targetId
  // from the existing set. If the LLM hallucinated, fall back to ADD.
  if ((op === "UPDATE" || op === "DELETE" || op === "NOOP") && !targetId) {
    return { op: "ADD", reason: "model returned op without valid targetId" };
  }
  return { op, targetId, reason: typeof obj.reason === "string" ? obj.reason : undefined };
}

// Re-export the parser for unit tests.
export const __test = { parseFacts, parseOperation };
