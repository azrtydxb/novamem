import { describe, expect, it } from "vitest";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { buildMcpServer } from "./mcp.js";
import { MemoryEngine } from "./engine/index.js";
import {
  asCold,
  asGraph,
  asWarm,
  FakeColdStore,
  FakeEmbedder,
  FakeGraphStore,
  FakeWarmStore,
} from "./test-fakes.js";

function makeEngine() {
  const warm = new FakeWarmStore();
  const cold = new FakeColdStore();
  const graph = new FakeGraphStore();
  const engine = new MemoryEngine({
    warm: asWarm(warm),
    cold: asCold(cold),
    graph: asGraph(graph),
    embedder: new FakeEmbedder(),
  });
  return { engine, warm, cold, graph };
}

/** Reach into the MCP Server's private handler map by re-using the SDK's
 *  request-schema dispatch. We exercise the registered handlers directly
 *  instead of standing up a real transport. */
async function callList(server: ReturnType<typeof buildMcpServer>) {
  // The SDK's `Server.setRequestHandler` registers under the schema's
  // `method` field. There's no public getter, so we ping via the standard
  // dispatch surface used by transports.
  const handler = (server as unknown as {
    _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
  })._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
  if (!handler) throw new Error("ListTools handler not registered");
  return handler({ method: "tools/list", params: {} } as never);
}

async function callTool(
  server: ReturnType<typeof buildMcpServer>,
  name: string,
  args: Record<string, unknown> = {},
) {
  const handler = (server as unknown as {
    _requestHandlers: Map<string, (req: unknown) => Promise<unknown>>;
  })._requestHandlers.get(CallToolRequestSchema.shape.method.value);
  if (!handler) throw new Error("CallTool handler not registered");
  return handler({
    method: "tools/call",
    params: { name, arguments: args },
  } as never);
}

describe("mcp: tools/list", () => {
  it("advertises the full memory_* tool surface", async () => {
    const { engine } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const r = (await callList(server)) as { tools: Array<{ name: string }> };
    const names = r.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "memory_search",
        "memory_remember",
        "memory_update",
        "memory_today",
        "memory_recent",
        "memory_neighbors",
        "memory_forget",
        "memory_stats",
        "project_list",
        "project_create",
        "project_delete",
        "project_activate",
        "project_deactivate",
        "project_share",
        "project_unshare",
      ].sort(),
    );
  });

  it("memory_search exposes weights override in input schema", async () => {
    const { engine } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const r = (await callList(server)) as { tools: Array<{ name: string; inputSchema: any }> };
    const search = r.tools.find((t) => t.name === "memory_search");
    expect(search?.inputSchema?.properties?.weights).toBeDefined();
    expect(search?.inputSchema?.properties?.weights?.properties).toMatchObject({
      keyword: expect.any(Object),
      vector: expect.any(Object),
      graph: expect.any(Object),
    });
  });
});

describe("mcp: tool dispatch", () => {
  it("memory_remember stores via engine and returns id", async () => {
    const { engine, warm } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const r = (await callTool(server, "memory_remember", { content: "via mcp", force: true })) as {
      content: Array<{ text: string }>;
    };
    const payload = JSON.parse(r.content[0]!.text);
    expect(warm.rows.has(payload.id)).toBe(true);
  });

  it("memory_search finds the just-stored entry", async () => {
    const { engine } = makeEngine();
    const server = buildMcpServer(engine, "public");
    await callTool(server, "memory_remember", { content: "Pascal likes coffee", force: true });
    const r = (await callTool(server, "memory_search", { query: "coffee" })) as {
      content: Array<{ text: string }>;
    };
    const payload = JSON.parse(r.content[0]!.text);
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.results[0].content).toContain("coffee");
  });

  it("memory_today uses a real 24h since cutoff (not search '*')", async () => {
    const { engine, warm } = makeEngine();
    const server = buildMcpServer(engine, "public");
    // Fresh entry
    const fresh = (await callTool(server, "memory_remember", { content: "fresh", force: true })) as {
      content: Array<{ text: string }>;
    };
    const freshId = JSON.parse(fresh.content[0]!.text).id;
    // Inject an old entry, force createdAt 2 days ago
    const old = (await callTool(server, "memory_remember", { content: "ancient", force: true })) as {
      content: Array<{ text: string }>;
    };
    const oldId = JSON.parse(old.content[0]!.text).id;
    warm.rows.get(oldId)!.createdAt = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const today = (await callTool(server, "memory_today", {})) as {
      content: Array<{ text: string }>;
    };
    const payload = JSON.parse(today.content[0]!.text);
    const ids = payload.results.map((x: { id: string }) => x.id);
    expect(ids).toContain(freshId);
    expect(ids).not.toContain(oldId);
  });

  it("memory_forget deletes the entry", async () => {
    const { engine, warm } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const created = (await callTool(server, "memory_remember", { content: "to delete", force: true })) as {
      content: Array<{ text: string }>;
    };
    const id = JSON.parse(created.content[0]!.text).id;
    await callTool(server, "memory_forget", { id });
    expect(warm.rows.has(id)).toBe(false);
  });

  it("memory_stats returns aggregate counts", async () => {
    const { engine } = makeEngine();
    const server = buildMcpServer(engine, "public");
    await callTool(server, "memory_remember", { content: "a", force: true });
    await callTool(server, "memory_remember", { content: "b", force: true });
    const r = (await callTool(server, "memory_stats", {})) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0]!.text);
    expect(payload.totalWarm).toBe(2);
    expect(payload.totalCold).toBe(0);
  });

  it("unknown tool name returns isError", async () => {
    const { engine } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const r = (await callTool(server, "memory.madeup", {})) as { isError?: boolean };
    expect(r.isError).toBe(true);
  });
});
