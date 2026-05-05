/**
 * Per-request guards required by the MCP 2025-11-25 spec for
 * HTTP-based transports. Both the Streamable HTTP route (/mcp) and
 * the legacy SSE route (/mcp/sse + /mcp/messages) call into these
 * before handing the request off to the SDK transport, so the
 * protocol-level checks happen consistently.
 *
 * Two MUSTs from the spec:
 *
 *   1. Origin validation — Transports § "Security Warning" #1:
 *      "Servers MUST validate the Origin header on all incoming
 *      connections to prevent DNS rebinding attacks." Same-origin and
 *      operator-allowlisted origins pass; missing Origin (non-browser
 *      clients) passes too.
 *
 *   2. MCP-Protocol-Version header — Transports § "Protocol Version
 *      Header": "If the server receives a request with an invalid or
 *      unsupported MCP-Protocol-Version, it MUST respond with 400 Bad
 *      Request." Missing header is allowed (older clients omit it; the
 *      SDK negotiates the version via the initialize JSON-RPC body).
 */
import type { FastifyReply, FastifyRequest } from "fastify";

/** MCP protocol versions this server speaks. The SDK at 1.29.0
 *  supports all of these via its initialize handshake; we keep the
 *  list explicit so a future bump is a one-line edit and a test can
 *  assert the surface. */
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);

export interface SpecGuardOptions {
  /** Allowed Origin values for browser-originated requests. Non-empty
   *  list = strict allowlist. Same-origin requests (Origin matches the
   *  request's Host) are always allowed regardless. */
  allowedOrigins: readonly string[];
}

/** Best-effort same-origin check. The reverse-proxy may have rewritten
 *  the host so we can't cryptographically prove same-origin, but the
 *  Origin header the browser sends is for the user-facing URL — that's
 *  what matters for DNS-rebinding defence. */
function isSameOrigin(origin: string, hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    const u = new URL(origin);
    return u.host === hostHeader;
  } catch {
    return false;
  }
}

/** Check the request's Origin header. Returns null when the request
 *  passes (no Origin / same-origin / allowlisted). Returns an error
 *  reason when it should be rejected. */
export function checkOrigin(
  req: FastifyRequest,
  opts: SpecGuardOptions,
): string | null {
  const origin = req.headers.origin;
  if (!origin || typeof origin !== "string") return null;
  // Wildcard allowlist — operator opted in to "anything goes."
  if (opts.allowedOrigins.includes("*")) return null;
  if (isSameOrigin(origin, req.headers.host)) return null;
  if (opts.allowedOrigins.includes(origin)) return null;
  return `origin '${origin}' not in allowlist`;
}

/** Check the request's MCP-Protocol-Version header. Header is
 *  case-insensitive; Fastify lowercases incoming headers. Returns null
 *  when the request passes (no header / known version). Returns an
 *  error reason when it should be 400'd. */
export function checkProtocolVersion(req: FastifyRequest): string | null {
  // Fastify lowercases header names; spec defines `MCP-Protocol-Version`
  // (case-insensitive) for the header. Read the lowercased form.
  const raw = req.headers["mcp-protocol-version"];
  if (raw === undefined) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  if (SUPPORTED_PROTOCOL_VERSIONS.has(value)) return null;
  return `unsupported MCP-Protocol-Version '${value}' — server speaks ${[
    ...SUPPORTED_PROTOCOL_VERSIONS,
  ].join(", ")}`;
}

/** Apply both guards in sequence. On failure writes the appropriate
 *  HTTP response and returns false; the caller should bail out. */
export function applyMcpGuards(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: SpecGuardOptions,
): boolean {
  const originErr = checkOrigin(req, opts);
  if (originErr) {
    req.log.warn({ origin: req.headers.origin, host: req.headers.host }, `mcp-guard: ${originErr}`);
    void reply.code(403).send({
      jsonrpc: "2.0",
      error: { code: -32000, message: `Forbidden: ${originErr}` },
      id: null,
    });
    return false;
  }
  const protoErr = checkProtocolVersion(req);
  if (protoErr) {
    void reply.code(400).send({
      jsonrpc: "2.0",
      error: { code: -32000, message: `Bad Request: ${protoErr}` },
      id: null,
    });
    return false;
  }
  return true;
}

export const __test__ = {
  SUPPORTED_PROTOCOL_VERSIONS,
};
