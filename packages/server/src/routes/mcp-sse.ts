/**
 * MCP-over-SSE transport bridge:
 *   GET  /mcp/sse                    — opens the event stream, returns sessionId
 *   POST /mcp/messages?sessionId=…   — sends JSON-RPC requests on that session
 *
 * Per-session transports live in a closure-scoped map for the lifetime of
 * the SSE connection. They're disposed when the client disconnects (close
 * or error) and force-drained on app close.
 *
 * Resource caps (issue #26):
 *   - Per-user concurrent-session cap (`MAX_SESSIONS_PER_USER`). A bearer
 *     holder otherwise opens unbounded SSE streams (each holds an event-
 *     loop fd + per-session `mcpServer`); SSE bypasses the per-IP rate
 *     limit because it's one long-lived connection. 429 once exceeded.
 *   - Idle-session expiry (`IDLE_TIMEOUT_MS`). A session with no
 *     `POST /mcp/messages` activity for 30 min is closed; its slot is
 *     returned to the per-user budget. The reaper sweeps every minute.
 */
import type { FastifyInstance } from "fastify";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { buildMcpServer } from "../mcp.js";
import type { RouteContext } from "./context.js";

/** Max concurrent SSE sessions for a single userId. Prevents an event-loop-
 *  fd / mcpServer-instance exhaustion vector that the per-IP rate limit
 *  doesn't cover (SSE is one long-lived connection, not many requests). */
const MAX_SESSIONS_PER_USER = 10;

/** Close a session that hasn't received a POST /mcp/messages in this many
 *  ms. Real clients send pings/tool calls regularly; truly idle sessions
 *  are dead clients holding fds. */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** How often the idle reaper scans the session map. */
const REAP_INTERVAL_MS = 60 * 1000;

/** SSE keepalive cadence. Override via `NOVAMEM_SSE_KEEPALIVE_MS` so tests
 *  can drive a short window without waiting 25 s. Must be shorter than
 *  the client's HTTP body-read
 *  timeout. undici (Node 20+ fetch / mcp-remote) defaults to 5 min before
 *  emitting `terminated: Body Timeout Error`; 25 s gives a comfortable
 *  margin even with a sluggish proxy in between. */
const DEFAULT_KEEPALIVE_INTERVAL_MS = 25 * 1000;
function resolveKeepaliveMs(): number {
  const raw = Number(process.env.NOVAMEM_SSE_KEEPALIVE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_KEEPALIVE_INTERVAL_MS;
}

interface SseSessionEntry {
  transport: SSEServerTransport;
  userId: string;
  mcpServer: ReturnType<typeof buildMcpServer>;
  /** Wall-clock ms of the most recent POST /mcp/messages. Initialised to
   *  the session's open time. */
  lastActivity: number;
}

export function register(app: FastifyInstance, ctx: RouteContext): void {
  // SSE-MCP: user is captured at the GET /mcp/sse handshake (when the
  // bearer auth hook ran and populated req.userId) and persisted with
  // the transport for the session's lifetime. Subsequent POST /mcp/messages
  // calls inherit that user id — they're authenticated by sessionId, not
  // by a new bearer header on every JSON-RPC call.
  const sseTransports = new Map<string, SseSessionEntry>();

  function countSessionsForUser(userId: string): number {
    let n = 0;
    for (const s of sseTransports.values()) if (s.userId === userId) n += 1;
    return n;
  }

  async function closeSession(sessionId: string): Promise<void> {
    const s = sseTransports.get(sessionId);
    if (!s) return;
    sseTransports.delete(sessionId);
    try {
      await s.mcpServer.close();
    } catch {
      // best-effort close
    }
  }

  // Idle reaper. Runs every minute; closes sessions whose lastActivity is
  // older than IDLE_TIMEOUT_MS. unref() so the timer doesn't keep the
  // event loop alive on shutdown.
  const reaper = setInterval(() => {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS;
    for (const [sessionId, s] of [...sseTransports.entries()]) {
      if (s.lastActivity < cutoff) {
        app.log.info({ sessionId, userId: s.userId }, "mcp-sse: idle session reaped");
        void closeSession(sessionId);
      }
    }
  }, REAP_INTERVAL_MS);
  reaper.unref?.();

  // Drain in-flight SSE connections on shutdown so Fastify's `close()`
  // doesn't hang waiting for keep-alive responses to complete.
  app.addHook("onClose", async () => {
    clearInterval(reaper);
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
    const userId = req.userId;
    // Per-user concurrent-session cap. Reject before opening the SSE
    // stream so we don't allocate a transport + mcpServer pair only to
    // throw it away.
    if (countSessionsForUser(userId) >= MAX_SESSIONS_PER_USER) {
      req.log.warn(
        { userId, cap: MAX_SESSIONS_PER_USER },
        "mcp-sse: per-user session cap exceeded",
      );
      return reply
        .code(429)
        .send({ error: "too many concurrent SSE sessions for this user" });
    }
    const transport = new SSEServerTransport("/mcp/messages", reply.raw);
    const sessionId = transport.sessionId;
    const mcpServer = buildMcpServer(ctx.engine, { userId }, ctx.warm);
    sseTransports.set(sessionId, {
      transport,
      userId,
      mcpServer,
      lastActivity: Date.now(),
    });
    await mcpServer.connect(transport);
    req.log.info({ sessionId, userId }, "mcp-sse: session opened");
    // SSE keepalive. Without periodic bytes, the client's HTTP body-read
    // hits its 5-minute idle timeout (undici's default in Node 20+) and
    // the EventSource emits "terminated: Body Timeout Error", forcing a
    // reconnect. `: ping\n\n` is the canonical SSE comment frame — `:`
    // marks a comment line, then a blank line ends the event. The SSE
    // spec accepts LF-LF, CRLF-CRLF, or CR-CR as separators; LF-LF is
    // what every browser and Node EventSource implementation expects.
    // Clients ignore the comment but the bytes reset their read timer.
    const keepalive = setInterval(() => {
      try {
        reply.raw.write(": ping\n\n");
      } catch {
        // Connection already torn down; the close/error listener below
        // will run cleanup on the next tick.
      }
    }, resolveKeepaliveMs());
    keepalive.unref?.();
    const cleanup = () => {
      clearInterval(keepalive);
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
    // Bind message posts to the session owner (issue #57). The SSE
    // sessionId is carried in the query string and is more likely to leak
    // (logs, browser history, traces, copied URLs) than an Authorization
    // header. Without this check, any authenticated user who learns a
    // sessionId can submit JSON-RPC messages into another user's MCP
    // session. Strict equality of req.userId to the userId captured at
    // the GET /mcp/sse handshake is enough — bearer auth always populates
    // req.userId on the POST.
    if (session.userId !== req.userId) {
      req.log.warn(
        { sessionId, sessionOwner: session.userId, caller: req.userId },
        "mcp-sse: rejected POST /mcp/messages from non-owner",
      );
      return reply.code(403).send({ error: "session belongs to another user" });
    }
    // Refresh activity stamp so the idle reaper leaves this session alone.
    session.lastActivity = Date.now();
    await session.transport.handlePostMessage(req.raw, reply.raw, req.body);
  });
}
