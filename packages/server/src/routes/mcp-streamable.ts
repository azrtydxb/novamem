/**
 * MCP-over-Streamable-HTTP transport bridge — the modern (2025-03-26)
 * MCP spec, single endpoint that handles POST + GET + DELETE on /mcp:
 *
 *   POST   /mcp   — JSON-RPC requests; new sessions on `initialize`
 *                   without an Mcp-Session-Id header
 *   GET    /mcp   — opens server→client SSE channel for an existing session
 *   DELETE /mcp   — terminates a session
 *
 * Sits alongside the legacy `/mcp/sse` + `/mcp/messages` routes (see
 * mcp-sse.ts). Modern clients (OpenAI Codex CLI, recent Cursor / Kilo,
 * future hosts) speak this transport; older clients keep the SSE pair.
 *
 * Resource caps mirror mcp-sse.ts:
 *   - Per-user concurrent-session cap (`MAX_SESSIONS_PER_USER`)
 *   - Idle-session expiry (`IDLE_TIMEOUT_MS`) — 30 min reaper sweep
 *
 * Session ownership is enforced on every POST/GET/DELETE: the userId
 * captured on the session-creating `initialize` is checked against
 * `req.userId` on subsequent calls, so a leaked session id can't be
 * driven by a different authenticated user (issue #57 carry-over from
 * the SSE side).
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { buildMcpServer } from "../mcp.js";
import { applyMcpGuards } from "./mcp-spec-guards.js";
import type { RouteContext } from "./context.js";

/** Max concurrent Streamable-HTTP sessions for a single userId. Matches
 *  the SSE-side cap so total per-user MCP-server load is bounded. */
const MAX_SESSIONS_PER_USER = 10;

/** Idle reaper threshold — sessions with no activity within this window
 *  are closed and the slot returned to the per-user budget. */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Reaper sweep cadence. */
const REAP_INTERVAL_MS = 60 * 1000;

interface StreamableSessionEntry {
  transport: StreamableHTTPServerTransport;
  userId: string;
  mcpServer: ReturnType<typeof buildMcpServer>;
  /** Last time any HTTP request hit this session. Bumped on POST/GET/DELETE. */
  lastActivity: number;
}

/** Read the Mcp-Session-Id request header in a header-name-case-
 *  insensitive way. Fastify lowercases headers, but be defensive against
 *  reverse-proxies that don't normalise. */
function readSessionId(req: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const v = req.headers["mcp-session-id"] ?? req.headers["Mcp-Session-Id"];
  return Array.isArray(v) ? v[0] : v;
}

/** Heuristic: an MCP `initialize` JSON-RPC request body. The Streamable
 *  spec only allows session creation on this method. We don't crack the
 *  full Zod schema — just check the method field — because the SDK's
 *  transport will validate everything else when it processes the body. */
function isInitializeRequest(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const m = (body as { method?: unknown }).method;
  return m === "initialize";
}

export function register(app: FastifyInstance, ctx: RouteContext): void {
  const sessions = new Map<string, StreamableSessionEntry>();

  function countSessionsForUser(userId: string): number {
    let n = 0;
    for (const s of sessions.values()) if (s.userId === userId) n += 1;
    return n;
  }

  async function closeSession(sessionId: string): Promise<void> {
    const s = sessions.get(sessionId);
    if (!s) return;
    sessions.delete(sessionId);
    try {
      await s.transport.close();
    } catch {
      // best-effort — transport may already be torn down
    }
    try {
      await s.mcpServer.close();
    } catch {
      // best-effort
    }
  }

  // Idle reaper — same shape as the SSE side.
  const reaper = setInterval(() => {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [sid, s] of [...sessions.entries()]) {
      if (s.lastActivity < cutoff) {
        app.log.info({ sessionId: sid, userId: s.userId }, "mcp-streamable: idle session reaped");
        void closeSession(sid);
      }
    }
  }, REAP_INTERVAL_MS);
  reaper.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(reaper);
    for (const [sid, s] of [...sessions.entries()]) {
      try {
        await s.transport.close();
      } catch {
        // ignore
      }
      try {
        await s.mcpServer.close();
      } catch {
        // ignore
      }
      sessions.delete(sid);
    }
  });

  /**
   * Create a new Streamable-HTTP session: allocate a transport, an
   * mcpServer, register them in the map, and wire the onclose handler
   * so a client-disconnect cleans up exactly once.
   *
   * Returns the new transport so the caller can hand the request off
   * for processing — the transport's handleRequest assigns the
   * sessionId once it processes the initialize body.
   */
  function createSession(userId: string): StreamableHTTPServerTransport {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        const mcpServer = buildMcpServer(ctx.engine, { userId }, ctx.warm);
        sessions.set(sid, {
          transport,
          userId,
          mcpServer,
          lastActivity: Date.now(),
        });
        // Fire-and-forget the connect — the SDK keeps a reference and
        // routes incoming JSON-RPC frames to the server.
        void mcpServer.connect(transport);
        app.log.info({ sessionId: sid, userId }, "mcp-streamable: session opened");
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (!sid) return;
      const s = sessions.get(sid);
      if (!s) return;
      sessions.delete(sid);
      s.mcpServer.close().catch(() => undefined);
      app.log.info({ sessionId: sid }, "mcp-streamable: session closed");
    };
    return transport;
  }

  /**
   * Common dispatch for all three verbs: resolve the session (or create
   * one for an `initialize` POST), authorize the caller, refresh the
   * activity stamp, and delegate to the SDK transport's handleRequest.
   */
  async function dispatch(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    // Spec MUSTs: validate Origin (DNS rebinding defence) and the
    // MCP-Protocol-Version header before any session work.
    if (!applyMcpGuards(req, reply, { allowedOrigins: ctx.corsOrigins })) return;
    const userId = req.userId;
    const sessionId = readSessionId(req);
    let transport: StreamableHTTPServerTransport;

    if (sessionId) {
      // Existing session — must exist + must belong to caller.
      const session = sessions.get(sessionId);
      if (!session) {
        return void reply.code(404).send({ error: "unknown sessionId" });
      }
      if (session.userId !== userId) {
        req.log.warn(
          { sessionId, sessionOwner: session.userId, caller: userId },
          "mcp-streamable: rejected request from non-owner",
        );
        return void reply.code(403).send({ error: "session belongs to another user" });
      }
      session.lastActivity = Date.now();
      transport = session.transport;
    } else if (req.method === "POST" && isInitializeRequest(req.body)) {
      // No session id + POST initialize → create one. Per-user cap
      // enforced before we allocate any transport / server pair.
      if (countSessionsForUser(userId) >= MAX_SESSIONS_PER_USER) {
        req.log.warn(
          { userId, cap: MAX_SESSIONS_PER_USER },
          "mcp-streamable: per-user session cap exceeded",
        );
        return void reply
          .code(429)
          .send({ error: "too many concurrent MCP sessions for this user" });
      }
      transport = createSession(userId);
    } else {
      // Per spec: GET / DELETE / non-initialize POST without a session
      // id is invalid. 400 with a JSON-RPC-shaped error so clients log
      // a useful message.
      return void reply.code(400).send({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            "Bad Request: missing Mcp-Session-Id (only POST initialize may omit it)",
        },
        id: null,
      });
    }

    // The transport drives the response from this point: writes status
    // headers, body, or upgrades to SSE for streaming. We MUST NOT call
    // reply.send() — Fastify already sees `reply.raw` as committed.
    await transport.handleRequest(req.raw, reply.raw, req.body);
  }

  // The MCP transports terminate the response themselves (the SDK writes
  // directly to reply.raw and may upgrade to SSE), so we can't validate
  // request bodies via zod here — the JSON-RPC payload schema lives in
  // the MCP spec, not ours. We document path-level metadata only and
  // leave the body unvalidated. `body: z.unknown()` would reject GET/DELETE,
  // and there's no useful response schema to attach.
  const mcpDoc = {
    schema: {
      tags: ["mcp"],
      summary: "MCP Streamable HTTP transport (2025-03-26+)",
      description:
        "Single-endpoint MCP transport. POST a JSON-RPC request; the response " +
        "is either a JSON document or a `text/event-stream` upgrade. The " +
        "session id is returned in the `Mcp-Session-Id` response header on " +
        "`initialize` and must be echoed on subsequent calls. GET opens a " +
        "server→client SSE channel; DELETE closes the session. Origin and " +
        "MCP-Protocol-Version are validated on every request.",
    },
  };
  app.post("/mcp", mcpDoc, dispatch);
  app.get("/mcp", mcpDoc, dispatch);
  app.delete("/mcp", mcpDoc, dispatch);
}
