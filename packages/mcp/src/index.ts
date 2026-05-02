/**
 * Remote MCP shim — exposes a remote novamem-server's tools over MCP stdio.
 * The server's local MCP (in packages/server/src/mcp.ts) talks to an
 * in-process engine; this shim talks to a remote engine via HTTP.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { NovamemClient } from "@azrty/novamem";

export function buildRemoteMcpServer(client: NovamemClient): Server {
  const server = new Server(
    { name: "novamem-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "memory.search",
        description: "Hybrid search across stored memories (remote novamem)",
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
        description: "Store a new memory entry (remote novamem)",
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
        description: "Recent entries (last 24h)",
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
    try {
      switch (req.params.name) {
        case "memory.search": {
          const r = await client.search({
            query: String(args.query),
            k: typeof args.k === "number" ? args.k : undefined,
            namespace: typeof args.namespace === "string" ? args.namespace : undefined,
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory.remember": {
          const r = await client.remember({
            content: String(args.content),
            namespace: typeof args.namespace === "string" ? args.namespace : undefined,
            source: typeof args.source === "string" ? args.source : undefined,
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory.today": {
          const r = await client.today({
            namespace: typeof args.namespace === "string" ? args.namespace : undefined,
            k: typeof args.k === "number" ? args.k : undefined,
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory.stats": {
          const r = await client.stats();
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        default:
          return {
            content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
            isError: true,
          };
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `error: ${(err as Error).message}` }],
        isError: true,
      };
    }
  });

  return server;
}

export async function startRemoteMcpStdio(client: NovamemClient): Promise<void> {
  const server = buildRemoteMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
