/**
 * MCP server exposing memory tools via stdio. The same engine instance backs
 * both HTTP and MCP — tool semantics are identical.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { MemoryEngine } from "./engine/index.js";

export function buildMcpServer(engine: MemoryEngine): Server {
  const server = new Server(
    { name: "novamem", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "memory.search",
        description:
          "Hybrid search across stored memories. Always runs keyword (FTS) + vector (cosine) + graph (neighbours) in parallel and fuses with weighted scoring. Default weights: keyword 0.3, vector 0.6, graph 0.1. Override `weights` only when you have a specific reason — e.g. `{ keyword: 1, vector: 0 }` to force exact-string match for ids/symbols, or `{ vector: 1, keyword: 0 }` to ignore literal token overlap and lean entirely on semantic similarity.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            k: { type: "number", description: "Top-K to return (default 10)" },
            namespace: { type: "string" },
            weights: {
              type: "object",
              description: "Per-signal weight overrides. Omit to use defaults.",
              properties: {
                keyword: { type: "number", description: "FTS keyword match weight" },
                vector: { type: "number", description: "Embedding cosine weight" },
                graph: { type: "number", description: "Graph-neighbour weight" },
              },
            },
          },
          required: ["query"],
        },
      },
      {
        name: "memory.remember",
        description: "Store a new memory entry",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string" },
            namespace: { type: "string" },
            source: { type: "string" },
          },
          required: ["content"],
        },
      },
      {
        name: "memory.today",
        description: "Recent entries (last 24h) for an optional namespace",
        inputSchema: {
          type: "object",
          properties: { namespace: { type: "string" }, k: { type: "number" } },
        },
      },
      {
        name: "memory.recent",
        description: "Recent entries in a namespace, ordered newest first. Optional ISO-8601 `since` lower bound.",
        inputSchema: {
          type: "object",
          properties: {
            namespace: { type: "string" },
            k: { type: "number" },
            since: { type: "string", description: "ISO-8601 timestamp" },
          },
        },
      },
      {
        name: "memory.neighbors",
        description: "Graph-neighbour traversal from a seed memory id",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            depth: { type: "number", description: "Traversal depth (default 1)" },
            k: { type: "number" },
          },
          required: ["id"],
        },
      },
      {
        name: "memory.forget",
        description: "Explicit deletion. Removes warm row, FTS, cold vector, and graph edges.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
      {
        name: "memory.stats",
        description: "Service-wide stats snapshot",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    switch (req.params.name) {
      case "memory.search": {
        const w = (args.weights ?? {}) as { keyword?: unknown; vector?: unknown; graph?: unknown };
        const weights =
          typeof w.keyword === "number" || typeof w.vector === "number" || typeof w.graph === "number"
            ? {
                ...(typeof w.keyword === "number" ? { keyword: w.keyword } : {}),
                ...(typeof w.vector === "number" ? { vector: w.vector } : {}),
                ...(typeof w.graph === "number" ? { graph: w.graph } : {}),
              }
            : undefined;
        const r = await engine.search({
          query: String(args.query),
          k: typeof args.k === "number" ? args.k : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          weights,
        });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.remember": {
        const r = await engine.remember({
          content: String(args.content),
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          source: typeof args.source === "string" ? args.source : undefined,
        });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.today": {
        // Last 24h, ordered newest first. Uses recent() so the window is real;
        // search('*') returned everything regardless of age.
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const r = await engine.recent({
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          k: typeof args.k === "number" ? args.k : 20,
          since,
        });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.recent": {
        const r = await engine.recent({
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          k: typeof args.k === "number" ? args.k : undefined,
          since: typeof args.since === "string" ? args.since : undefined,
        });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.neighbors": {
        const r = await engine.neighbors({
          id: String(args.id),
          depth: typeof args.depth === "number" ? args.depth : undefined,
          k: typeof args.k === "number" ? args.k : undefined,
        });
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.forget": {
        const r = await engine.forget(String(args.id));
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      case "memory.stats": {
        const r = await engine.stats();
        return { content: [{ type: "text", text: JSON.stringify(r) }] };
      }
      default:
        return {
          content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
          isError: true,
        };
    }
  });

  return server;
}

export async function startMcpStdio(engine: MemoryEngine): Promise<void> {
  const server = buildMcpServer(engine);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
