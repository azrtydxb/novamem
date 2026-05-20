import { z } from "zod";

export const benchmarkKindSchema = z.enum(["longmemeval", "locomo", "beir", "rag", "long-context", "novamem-specific"]);

export const benchmarkMemorySchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  timestamp: z.string().optional(),
  sessionId: z.string().optional(),
  supersededBy: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const benchmarkQuerySchema = z.object({
  queryId: z.string().min(1),
  text: z.string().min(1),
  expectedAnswer: z.string().optional(),
  relevantMemoryIds: z.array(z.string().min(1)).default([]),
  forbiddenMemoryIds: z.array(z.string().min(1)).optional(),
  category: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const benchmarkFixtureSchema = z.object({
  name: z.string().min(1),
  kind: benchmarkKindSchema,
  version: z.string().min(1),
  description: z.string().optional(),
  source: z.object({
    name: z.string().min(1),
    url: z.string().url().optional(),
    license: z.string().optional(),
    notes: z.string().optional(),
  }).strict().optional(),
  memories: z.array(benchmarkMemorySchema).min(1),
  queries: z.array(benchmarkQuerySchema).min(1),
}).strict().superRefine((fixture, ctx) => {
  const ids = new Set(fixture.memories.map((m) => m.id));
  for (const query of fixture.queries) {
    for (const id of query.relevantMemoryIds) {
      if (!ids.has(id)) ctx.addIssue({ code: "custom", path: ["queries", query.queryId, "relevantMemoryIds"], message: `unknown relevant memory id: ${id}` });
    }
    for (const id of query.forbiddenMemoryIds ?? []) {
      if (!ids.has(id)) ctx.addIssue({ code: "custom", path: ["queries", query.queryId, "forbiddenMemoryIds"], message: `unknown forbidden memory id: ${id}` });
    }
  }
});
