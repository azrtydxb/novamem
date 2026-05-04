/**
 * MCP-over-SSE transport bridge:
 *   GET  /mcp/sse                    — opens the event stream, returns sessionId
 *   POST /mcp/messages?sessionId=…   — sends JSON-RPC requests on that session
 *
 * Per-session transports live in a closure-scoped map for the lifetime of
 * the SSE connection. They're disposed when the client disconnects (close
 * or error) and force-drained on app close.
 */
import type { FastifyInstance } from "fastify";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { buildMcpServer } from "../mcp.js";
import type { RouteContext } from "./context.js";

export function register(app: FastifyInstance, ctx: RouteContext): void {
  // SSE-MCP: user is captured at the GET /mcp/sse handshake (when the
  // bearer auth hook ran and populated req.userId) and persisted with
  // the transport for the session's lifetime. Subsequent POST /mcp/messages
  // calls inherit that user id — they're authenticated by sessionId, not
  // by a new bearer header on every JSON-RPC call.
  const sseTransports = new Map<string, {
    transport: SSEServerTransport;
    userId: string;
    mcpServer: ReturnType<typeof buildMcpServer>;
  }>();

  // Drain in-flight SSE connections on shutdown so Fastify's `close()`
  // doesn't hang waiting for keep-alive responses to complete.
  app.addHook("onClose", async () => {
    for (const [sessionId, s] of [...sseTransports.entries()]) {
      try {
        await s.mcpServer.close();
      } catch {
        // ignore — best-effort drain
      }
      sseTransports.delete(sessionId);
    }
  });

  app.get("/mcp/sse", async (req, reply) => {
    const transport = new SSEServerTransport("/mcp/messages", reply.raw);
    const sessionId = transport.sessionId;
    const userId = req.userId;
    const mcpServer = buildMcpServer(ctx.engine, { userId }, ctx.warm);
    sseTransports.set(sessionId, { transport, userId, mcpServer });
    await mcpServer.connect(transport);
    req.log.info({ sessionId, userId }, "mcp-sse: session opened");
    const cleanup = () => {
      sseTransports.delete(sessionId);
      mcpServer.close().catch(() => undefined);
      req.log.info({ sessionId }, "mcp-sse: session closed");
    };
    // Listen on both `close` and `error` — cleanup-only-on-close leaks
    // the entry when an `error` event fires.
    reply.raw.on("close", cleanup);
    reply.raw.on("error", cleanup);
  });

  app.post("/mcp/messages", async (req, reply) => {
    const sessionId = (req.query as { sessionId?: string }).sessionId;
    if (!sessionId) return reply.code(400).send({ error: "missing sessionId" });
    const session = sseTransports.get(sessionId);
    if (!session) return reply.code(404).send({ error: "unknown sessionId" });
    await session.transport.handlePostMessage(req.raw, reply.raw, req.body);
  });
}
