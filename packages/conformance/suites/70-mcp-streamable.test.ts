import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { api, ns } from "../src/client.js";
import { env } from "../src/env.js";

/**
 * Read-only transcription sources: `packages/server/src/routes/
 * mcp-streamable.ts` (transport wiring), `mcp-spec-guards.ts` (Origin +
 * MCP-Protocol-Version MUSTs), `mcp-tools.ts` (tool advertisement).
 * Never imported — this suite talks to the live oracle only.
 */

/**
 * `client.close()` alone drops the socket without telling the server,
 * so the session lingers until the 30-minute idle reaper. Six sessions
 * per run against a cap of ten means a second run inside that window
 * fails on "too many concurrent MCP sessions" — on either server, the
 * cap and the timeout being identical. The transport comes back with
 * the client so each test can DELETE its session on the way out.
 */
async function connect(): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const client = new Client({ name: "novamem-conformance", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${env.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${env.testToken}` } },
  });
  await client.connect(transport);
  return { client, transport };
}

async function disconnect(client: Client, transport: StreamableHTTPClientTransport) {
  await transport.terminateSession();
  await client.close();
}

const toolJson = (r: unknown) =>
  JSON.parse(((r as { content: Array<{ text: string }> }).content)[0]!.text);

const SNAPSHOT = new URL("../reference/tools.snapshot.json", import.meta.url);

describe("MCP streamable transport", () => {
  it("initializes and advertises the snapshotted tool surface", async () => {
    const { client, transport } = await connect();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names.length).toBeGreaterThanOrEqual(21);
      if (!existsSync(SNAPSHOT)) {
        throw new Error(
          "reference/tools.snapshot.json missing — regenerate with scripts/snapshot-tools.mjs against the oracle",
        );
      }
      const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as {
        names: string[];
        schemas: Record<string, unknown>;
      };
      expect(names).toEqual(snapshot.names);
      // Schema drift matters as much as name drift: hosts build arg UIs
      // and validation from inputSchema.
      for (const t of tools) {
        expect(snapshot.schemas[t.name], `schema for ${t.name}`).toEqual(t.inputSchema);
      }
    } finally {
      await disconnect(client, transport);
    }
  });

  it("memory_remember -> memory_search -> memory_forget round-trip", async () => {
    const { client, transport } = await connect();
    try {
      const shelf = ns();
      const fact = `the mcp conformance marker for this run is ${shelf}`;
      const stored = toolJson(
        await client.callTool({
          name: "memory_remember",
          arguments: { content: fact, namespace: shelf },
        }),
      );
      expect(stored.id).toBeTruthy();
      const found = toolJson(
        await client.callTool({
          name: "memory_search",
          arguments: { query: "mcp conformance marker", namespace: shelf },
        }),
      );
      expect(JSON.stringify(found)).toContain(shelf);
      const gone = toolJson(
        await client.callTool({ name: "memory_forget", arguments: { id: stored.id } }),
      );
      expect(gone.deleted).toBe(true);
    } finally {
      await disconnect(client, transport);
    }
  });

  it("unknown tool name is a tool-level error, not a transport crash", async () => {
    const { client, transport } = await connect();
    try {
      const r = await client.callTool({ name: "memory_nonexistent", arguments: {} });
      expect(r.isError).toBe(true);
    } catch (err) {
      // Some SDK versions surface it as a JSON-RPC error instead —
      // either is spec-conforming; a dropped connection is not.
      expect(String(err)).toMatch(/tool|unknown|not found/i);
    } finally {
      await disconnect(client, transport);
    }
  });

  it("malformed arguments are a tool error with a message", async () => {
    const { client, transport } = await connect();
    try {
      const r = await client.callTool({ name: "memory_search", arguments: {} });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toMatch(/query/i);
    } finally {
      await disconnect(client, transport);
    }
  });

  it("spec guard: disallowed Origin answers 403", async () => {
    const r = await api("/mcp", {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      headers: { origin: "https://evil.example.com" },
    });
    expect(r.status).toBe(403);
  });

  it("spec guard: unsupported MCP-Protocol-Version answers 400", async () => {
    const r = await api("/mcp", {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      headers: { "mcp-protocol-version": "1999-01-01" },
    });
    expect(r.status).toBe(400);
  });
});
