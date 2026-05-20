export interface LongMemEvalTurn {
  role: string;
  content: string;
}

export interface LongMemEvalChunkInput {
  questionId: string;
  sessionId: string;
  date: string;
  turns: LongMemEvalTurn[];
}

export interface LongMemEvalMemoryResult {
  memory: string;
  score?: number;
  created_at?: string;
}

export function normalizeLongMemEvalCutoffs(cutoffs: number[], maxNovaMemK = 200): number[] {
  const unique = [...new Set(cutoffs)].sort((a, b) => a - b);
  const tooLarge = unique.filter((k) => k > maxNovaMemK);
  if (tooLarge.length > 0) {
    throw new Error(`Cannot report ${tooLarge.map((k) => `top_${k}`).join(", ")}: NovaMem /v1/search currently enforces k <= ${maxNovaMemK}. Change the API limit or use a separate retrieval path first.`);
  }
  return unique;
}

function formatTurns(sessionId: string, date: string, turns: LongMemEvalTurn[]): string {
  const lines = [`Session: ${sessionId}`, `Date: ${date}`];
  for (const turn of turns) {
    const content = turn.content?.trim();
    if (content) lines.push(`${turn.role}: ${content}`);
  }
  return lines.join("\n");
}

export function chunkLongMemEvalSession(input: LongMemEvalChunkInput, turnsPerChunk = 2): Array<{ content: string; metadata: Record<string, unknown> }> {
  const turns = input.turns.filter((turn) => turn.content?.trim());
  const chunks: Array<{ content: string; metadata: Record<string, unknown> }> = [];
  for (let i = 0; i < turns.length; i += turnsPerChunk) {
    const chunk = turns.slice(i, i + turnsPerChunk);
    const chunkIndex = Math.floor(i / turnsPerChunk);
    chunks.push({
      content: `[LongMemEval question=${input.questionId} session=${input.sessionId} chunk=${chunkIndex}]\n${formatTurns(input.sessionId, input.date, chunk)}`,
      metadata: {
        benchmark: "longmemeval",
        question_id: input.questionId,
        session_id: input.sessionId,
        chunk: chunkIndex,
      },
    });
  }
  return chunks;
}

function formatMemories(memories: LongMemEvalMemoryResult[], maxCharsEach: number, maxTotalChars: number): string {
  const lines: string[] = [];
  let total = 0;
  for (const [index, result] of memories.entries()) {
    let memory = result.memory.trim();
    if (memory.length > maxCharsEach) memory = `${memory.slice(0, maxCharsEach)}…`;
    let line = `${index + 1}. ${memory}`;
    if (result.created_at) line += ` [created: ${result.created_at}]`;
    if (total + line.length > maxTotalChars) break;
    lines.push(line);
    total += line.length;
  }
  return lines.length > 0 ? lines.join("\n") : "(No relevant memories found)";
}

export function buildLongMemEvalAnswerPrompt(opts: {
  question: string;
  questionDate?: string;
  memories: LongMemEvalMemoryResult[];
  maxCharsEach?: number;
  maxTotalChars?: number;
}): string {
  const memories = formatMemories(opts.memories, opts.maxCharsEach ?? 8_000, opts.maxTotalChars ?? 180_000);
  return `You are a personal assistant with access to memories from past conversations with a user. Answer the question using only the memories below. Be concise.

Rules:
- If the memories contain enough information, answer directly.
- If the answer is not supported, say: The information provided is not enough.
- For conflicting facts, prefer the most recent memory.
- For temporal/counting questions, compute carefully from the dates in the memories.

Question date: ${opts.questionDate ?? ""}
Question: ${opts.question}

Memories:
${memories}

Answer only, no hidden reasoning:`;
}

export function buildLongMemEvalJudgePrompt(opts: { question: string; answer: string; hypothesis: string }): string {
  return `Judge whether the model response correctly answers the question according to the ground truth. Use semantic equivalence, not exact wording.

Return JSON only in this exact shape:
{"judgment":"PASS" or "FAIL", "score": 1 or 0, "reason":"short reason"}

Question: ${opts.question}
Ground truth answer: ${opts.answer}
Model response: ${opts.hypothesis}`;
}

export function parseJudgeJson(text: string): { judgment: "PASS" | "FAIL"; score: 0 | 1; reason: string; raw?: string } {
  const match = /\{[\s\S]*\}/.exec(text);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { judgment?: unknown; score?: unknown; reason?: unknown };
      const judgmentText = String(parsed.judgment ?? "").toUpperCase();
      const scoreNum = Number(parsed.score ?? (judgmentText === "PASS" ? 1 : 0));
      const score: 0 | 1 = judgmentText === "PASS" || scoreNum >= 0.5 ? 1 : 0;
      return { judgment: score === 1 ? "PASS" : "FAIL", score, reason: String(parsed.reason ?? "") };
    } catch {
      // fall through
    }
  }
  const upper = text.toUpperCase();
  const score: 0 | 1 = upper.includes("PASS") && !upper.includes("FAIL") ? 1 : 0;
  return { judgment: score === 1 ? "PASS" : "FAIL", score, reason: "fallback parse", raw: text.slice(0, 500) };
}
