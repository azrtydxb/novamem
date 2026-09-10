import type {
  BenchmarkFixture,
  BenchmarkMemory,
  BenchmarkQuery,
} from "./types.js";

function asText(
  turns: Array<{
    role?: string;
    speaker?: string;
    content?: string;
    text?: string;
  }>
): string {
  return turns
    .map(
      (t) => `${t.role ?? t.speaker ?? "speaker"}: ${t.content ?? t.text ?? ""}`
    )
    .join("\n");
}

export function adaptLongMemEvalFixture(input: {
  dataset: string;
  conversations: Array<{
    session_id: string;
    date?: string;
    turns: Array<{ role: string; content: string }>;
  }>;
  questions: Array<{
    question_id: string;
    question: string;
    answer?: string;
    evidence_session_ids: string[];
    category?: string;
  }>;
}): BenchmarkFixture {
  const memories = input.conversations.map(
    (session): BenchmarkMemory => ({
      id: `${input.dataset}:${session.session_id}`,
      text: asText(session.turns),
      timestamp: session.date,
      sessionId: session.session_id,
      metadata: {
        sourceFormat: "LongMemEval",
        turnCount: session.turns.length,
      },
    })
  );
  const queries = input.questions.map(
    (q): BenchmarkQuery => ({
      queryId: q.question_id,
      text: q.question,
      expectedAnswer: q.answer,
      relevantMemoryIds: q.evidence_session_ids.map(
        (id) => `${input.dataset}:${id}`
      ),
      category: q.category ?? "long-term-chat-memory",
    })
  );
  return {
    name: input.dataset,
    kind: "longmemeval",
    version: "adapter-v1",
    source: { name: "LongMemEval", url: "https://arxiv.org/abs/2410.10813" },
    memories,
    queries,
  };
}

export function adaptLoCoMoFixture(input: {
  conversation_id: string;
  sessions: Array<{
    session_id: string;
    speaker?: string;
    text: string;
    timestamp?: string;
  }>;
  qa: Array<{
    id: string;
    question: string;
    answer?: string;
    evidence: string[];
    category?: string;
  }>;
}): BenchmarkFixture {
  return {
    name: input.conversation_id,
    kind: "locomo",
    version: "adapter-v1",
    source: { name: "LoCoMo", url: "https://snap-research.github.io/locomo/" },
    memories: input.sessions.map((s) => ({
      id: `${input.conversation_id}:${s.session_id}`,
      text: s.text,
      timestamp: s.timestamp,
      sessionId: s.session_id,
      metadata: { sourceFormat: "LoCoMo", speaker: s.speaker },
    })),
    queries: input.qa.map((q) => ({
      queryId: q.id,
      text: q.question,
      expectedAnswer: q.answer,
      relevantMemoryIds: q.evidence.map(
        (id) => `${input.conversation_id}:${id}`
      ),
      category: q.category ?? "conversational-memory",
    })),
  };
}

export function adaptBeirFixture(input: {
  name: string;
  corpus: Record<string, { title?: string; text: string }>;
  queries: Record<string, string>;
  qrels: Record<string, Record<string, number>>;
}): BenchmarkFixture {
  return {
    name: input.name,
    kind: "beir",
    version: "adapter-v1",
    source: { name: "BEIR", url: "https://github.com/beir-cellar/beir" },
    memories: Object.entries(input.corpus).map(([id, doc]) => ({
      id,
      text: [doc.title, doc.text].filter(Boolean).join("\n"),
      metadata: { sourceFormat: "BEIR" },
    })),
    queries: Object.entries(input.queries).map(([id, text]) => ({
      queryId: id,
      text,
      relevantMemoryIds: Object.entries(input.qrels[id] ?? {})
        .filter(([, score]) => score > 0)
        .map(([docId]) => docId),
      category: "retrieval",
    })),
  };
}

export function adaptRagFixture(input: {
  name: string;
  documents: Array<{
    id: string;
    text: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }>;
  questions: Array<{
    id: string;
    question: string;
    answer?: string;
    evidence: string[];
    category?: string;
  }>;
}): BenchmarkFixture {
  return {
    name: input.name,
    kind: "rag",
    version: "adapter-v1",
    source: { name: "RAG QA fixture" },
    memories: input.documents.map((doc) => ({
      id: doc.id,
      text: [doc.title, doc.text].filter(Boolean).join("\n"),
      metadata: { sourceFormat: "RAG", ...(doc.metadata ?? {}) },
    })),
    queries: input.questions.map((q) => ({
      queryId: q.id,
      text: q.question,
      expectedAnswer: q.answer,
      relevantMemoryIds: q.evidence,
      category: q.category ?? "rag-answering",
    })),
  };
}

export function adaptLongContextFixture(input: {
  name: string;
  haystack: string[];
  questions: Array<{
    id: string;
    question: string;
    answer?: string;
    evidence_indexes: number[];
  }>;
}): BenchmarkFixture {
  return {
    name: input.name,
    kind: "long-context",
    version: "adapter-v1",
    source: {
      name: "RULER/NIAH-style",
      url: "https://github.com/NVIDIA/RULER",
    },
    memories: input.haystack.map((text, i) => ({
      id: `${input.name}:needle:${i}`,
      text,
      metadata: { sourceFormat: "long-context", index: i },
    })),
    queries: input.questions.map((q) => ({
      queryId: q.id,
      text: q.question,
      expectedAnswer: q.answer,
      relevantMemoryIds: q.evidence_indexes.map(
        (i) => `${input.name}:needle:${i}`
      ),
      category: "needle-retrieval",
    })),
  };
}

export function adaptNovaMemFixture(input: {
  name: string;
  memories: Array<{
    id: string;
    text: string;
    supersededBy?: string;
    metadata?: Record<string, unknown>;
  }>;
  queries: Array<{
    id: string;
    text: string;
    answer?: string;
    relevant: string[];
    forbidden?: string[];
    category?: string;
  }>;
}): BenchmarkFixture {
  return {
    name: input.name,
    kind: "novamem-specific",
    version: "adapter-v1",
    description:
      "NovaMem-specific coverage for supersession, project/sensitivity/adoption behaviours, and graph recall.",
    memories: input.memories.map((m) => ({
      id: m.id,
      text: m.text,
      supersededBy: m.supersededBy,
      metadata: { sourceFormat: "NovaMem", ...(m.metadata ?? {}) },
    })),
    queries: input.queries.map((q) => ({
      queryId: q.id,
      text: q.text,
      expectedAnswer: q.answer,
      relevantMemoryIds: q.relevant,
      forbiddenMemoryIds: q.forbidden,
      category: q.category ?? "novamem-specific",
    })),
  };
}
