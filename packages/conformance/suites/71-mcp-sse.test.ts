import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { env } from "../src/env.js";

/**
 * Legacy SSE transport (/mcp/sse + /mcp/messages), exercised at the wire
 * level: open the stream, capture the `endpoint` frame's sessionId, POST
 * JSON-RPC to /mcp/messages, read responses back off the stream (POSTs
 * answer 202; results arrive as SSE `message` frames). Raw fetch rather
 * than the SDK client — the SDK's EventSource polyfill fights this
 * legacy transport, and the wire IS the contract the Go server must
 * reproduce. Transcription source: routes/mcp-sse.ts (read-only).
 */

const SNAPSHOT = new URL("../reference/tools.snapshot.json", import.meta.url);

describe("MCP legacy SSE transport", () => {
  it("handshake advertises the same tool surface; a tool call round-trips", async () => {
    const ctrl = new AbortController();
    try {
      const sse = await fetch(`${env.url}/mcp/sse`, {
        headers: { authorization: `Bearer ${env.testToken}` },
        signal: ctrl.signal,
      });
      expect(sse.status).toBe(200);
      const reader = sse.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const readUntil = async (
        pred: (buf: string) => boolean
      ): Promise<void> => {
        const deadline = Date.now() + 20_000;
        while (!pred(buf)) {
          if (Date.now() > deadline)
            throw new Error(`SSE frame timeout; buffer: ${buf.slice(-400)}`);
          const { value, done } = await reader.read();
          if (done) throw new Error("SSE stream closed early");
          buf += decoder.decode(value, { stream: true });
        }
      };

      await readUntil((b) => /sessionId=([A-Za-z0-9_-]+)/.test(b));
      const sessionId = buf.match(/sessionId=([A-Za-z0-9_-]+)/)![1];

      const post = async (body: unknown): Promise<void> => {
        const r = await fetch(
          `${env.url}/mcp/messages?sessionId=${sessionId}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${env.testToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
          }
        );
        // SSEServerTransport acks the POST; the JSON-RPC result arrives
        // on the stream.
        expect([200, 202]).toContain(r.status);
      };

      // The frame for a response id can span reads; match on the id then
      // extract that frame's data line.
      const messageFor = (
        id: number
      ): { result?: unknown; error?: unknown } | undefined => {
        const frames = buf.split("\n\n");
        for (const f of frames) {
          const data = f
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("");
          if (!data) continue;
          try {
            const msg = JSON.parse(data) as {
              id?: number;
              result?: unknown;
              error?: unknown;
            };
            if (msg.id === id) return msg;
          } catch {
            /* partial frame */
          }
        }
        return undefined;
      };
      const resultFor = (id: number): unknown => {
        const msg = messageFor(id);
        if (msg?.error)
          throw new Error(
            `JSON-RPC error for id ${id}: ${JSON.stringify(msg.error)}`
          );
        return msg?.result;
      };

      await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "conf-sse", version: "0" },
        },
      });
      await readUntil(() => resultFor(1) !== undefined);
      await post({ jsonrpc: "2.0", method: "notifications/initialized" });

      await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      await readUntil(() => resultFor(2) !== undefined);
      const tools = (resultFor(2) as { tools: Array<{ name: string }> }).tools;
      const names = tools.map((t) => t.name).sort();
      if (existsSync(SNAPSHOT)) {
        const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as {
          names: string[];
        };
        expect(names).toEqual(snapshot.names);
      } else {
        expect(names.length).toBeGreaterThanOrEqual(21);
      }

      // Namespace-SCOPED memory_recent, not memory_stats: unscoped
      // recent/stats fan out one query per namespace — measured ~33s on
      // the bench corpus's 527 shelves (44ms scoped). Any tool
      // round-trip proves the transport; take the O(1) one.
      await post({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "memory_recent",
          arguments: { k: 1, namespace: "default" },
        },
      });
      await readUntil(() => resultFor(3) !== undefined);
      const recent = JSON.parse(
        (resultFor(3) as { content: Array<{ text: string }> }).content[0]!.text
      );
      expect(recent).toHaveProperty("results");
      await reader.cancel();
    } finally {
      ctrl.abort();
    }
  }, 60_000);
});
