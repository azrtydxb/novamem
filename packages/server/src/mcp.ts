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
        description: "Hybrid search across stored memories",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            k: { type: "number" },
            namespace: { type: "string" },
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
        const r = await engine.search({
          query: String(args.query),
          k: typeof args.k === "number" ? args.k : undefined,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
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
        const r = await engine.search({
          query: "*",
          k: typeof args.k === "number" ? args.k : 20,
          namespace: typeof args.namespace === "string" ? args.namespace : undefined,
        });
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
