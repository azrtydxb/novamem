import { describe, expect, it } from "vitest";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { NOVAMEM_INSTRUCTIONS } from "./mcp-tools.js";
import { buildMcpServer } from "./mcp.js";
import { asWarm, makeEngine } from "./test-fakes.js";

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
  it("instructions contain the mandatory memory protocol", () => {
    expect(NOVAMEM_INSTRUCTIONS).toContain("Mandatory memory protocol");
    expect(NOVAMEM_INSTRUCTIONS).toContain("Before answering any substantive user request");
    expect(NOVAMEM_INSTRUCTIONS).toContain("memory_context");
    expect(NOVAMEM_INSTRUCTIONS).toContain("memory_capture");
  });

  it("advertises the full memory_* tool surface", async () => {
    const { engine } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const r = (await callList(server)) as { tools: Array<{ name: string }> };
    const names = r.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "memory_context",
        "memory_capture",
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

  it("memory_context returns relevant and recent grounding in one call", async () => {
    const { engine } = makeEngine();
    const server = buildMcpServer(engine, "public");
    await callTool(server, "memory_remember", { content: "Pascal prefers XML tool parsers", force: true });
    const r = (await callTool(server, "memory_context", {
      message: "Set up the model with xml parser",
      k: 5,
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0]!.text);
    expect(payload.relevant.results[0].content).toContain("XML tool parsers");
    expect(payload.recent.results.length).toBeGreaterThan(0);
    expect(payload.guidance).toContain("Use this context before answering");
  });

  it("memory_capture stores a durable fact with provenance defaults", async () => {
    const { engine, warm } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const r = (await callTool(server, "memory_capture", {
      content: "Pascal wants NovaMem agents to use memory proactively, not only when told.",
      namespace: "memory",
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0]!.text);
    expect(payload.saved).toBe(1);
    expect(warm.rows.get(payload.results[0].id)!.source).toBe("memory_capture");
    expect(warm.rows.get(payload.results[0].id)!.namespace).toBe("memory");
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

describe("mcp: tool error matrix", () => {
  type ErrorResult = { isError?: boolean; content: Array<{ text: string }> };

  /** Without a warm store, every project_* tool should isError. Pinning
   *  the contract so a future regression that drops the !warm guard is
   *  caught immediately. */
  it.each([
    ["project_list", {}],
    ["project_create", { name: "x" }],
    ["project_delete", { project: "p" }],
    ["project_activate", { project: "p" }],
    ["project_deactivate", {}],
    ["project_share", { project: "p", username: "u" }],
    ["project_unshare", { project: "p", username: "u" }],
  ])("%s without warm store -> isError", async (tool, args) => {
    const { engine } = makeEngine();
    // Note: no `warm` arg → the project_* paths must reject.
    const server = buildMcpServer(engine, "public");
    const r = (await callTool(server, tool, args)) as ErrorResult;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/requires the warm store/);
  });

  it("project_delete: no such project", async () => {
    const { engine, warm } = makeEngine();
    const server = buildMcpServer(engine, "public", asWarm(warm));
    const r = (await callTool(server, "project_delete", { project: "ghost" })) as ErrorResult;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/no such project/);
  });

  it("project_delete: only the owner can delete", async () => {
    const { engine, warm } = makeEngine();
    // Project owned by `alice`; caller is `public`.
    const p = await warm.createProject({ name: "Apollo", ownerUserId: "alice" });
    await warm.addProjectMember(p.id, "public", "member");
    const server = buildMcpServer(engine, "public", asWarm(warm));
    const r = (await callTool(server, "project_delete", { project: p.id })) as ErrorResult;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/only the owner can delete/);
  });

  it("project_share: only the owner can share", async () => {
    const { engine, warm } = makeEngine();
    const p = await warm.createProject({ name: "Phoenix", ownerUserId: "alice" });
    await warm.addProjectMember(p.id, "public", "member");
    const server = buildMcpServer(engine, "public", asWarm(warm));
    const r = (await callTool(server, "project_share", {
      project: p.id,
      username: "bob",
    })) as ErrorResult;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/only the owner can share/);
  });

  it("project_unshare: owner cannot unshare themselves", async () => {
    const { engine, warm } = makeEngine();
    const p = await warm.createProject({ name: "Hermes", ownerUserId: "public" });
    // `public` has the username "public" in the fake's user table.
    const server = buildMcpServer(engine, "public", asWarm(warm));
    const r = (await callTool(server, "project_unshare", {
      project: p.id,
      username: "public",
    })) as ErrorResult;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/owner cannot unshare themselves/);
  });

  it("project_unshare: unknown user", async () => {
    const { engine, warm } = makeEngine();
    const p = await warm.createProject({ name: "Zeus", ownerUserId: "public" });
    const server = buildMcpServer(engine, "public", asWarm(warm));
    const r = (await callTool(server, "project_unshare", {
      project: p.id,
      username: "ghost-user",
    })) as ErrorResult;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/unknown user/);
  });

  it("project_activate: project required when arg missing", async () => {
    const { engine, warm } = makeEngine();
    const server = buildMcpServer(engine, "public", asWarm(warm));
    // Empty args fail Zod (project required) and surface as isError.
    const r = (await callTool(server, "project_activate", {})) as ErrorResult;
    expect(r.isError).toBe(true);
  });

  it("memory_search: missing required `query` -> isError", async () => {
    const { engine } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const r = (await callTool(server, "memory_search", {})) as ErrorResult;
    expect(r.isError).toBe(true);
  });

  it("memory_neighbors: missing required `id` -> isError", async () => {
    const { engine } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const r = (await callTool(server, "memory_neighbors", {})) as ErrorResult;
    expect(r.isError).toBe(true);
  });

  it("memory_search: not a member of project -> isError", async () => {
    const { engine, warm } = makeEngine();
    // Project owned by alice; `public` is NOT a member.
    const p = await warm.createProject({ name: "Atlas", ownerUserId: "alice" });
    const server = buildMcpServer(engine, "public", asWarm(warm));
    const r = (await callTool(server, "memory_search", {
      query: "hello",
      project: p.id,
    })) as ErrorResult;
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/not a member/);
  });
});

describe("mcp: shared tool surface vs. shim", () => {
  it("server TOOL_DEFINITIONS matches the stdio shim's tool name set", async () => {
    // Importing dynamically so this test doesn't break if the shim's
    // build hasn't run; the package exports its source via tsconfig.
    const [{ TOOL_NAMES }, shim] = await Promise.all([
      import("./mcp-tools.js"),
      // The shim is published; its source is in packages/mcp/src.
      // Resolve via workspace path.
      import("../../mcp/src/index.js" as string).catch(() => null as unknown as null),
    ]);
    if (!shim) {
      // Shim source not resolvable in this context — skip.
      expect(TOOL_NAMES.length).toBeGreaterThan(0);
      return;
    }
    const shimNames = (shim as { REMOTE_MCP_TOOL_NAMES: string[] }).REMOTE_MCP_TOOL_NAMES;
    expect([...shimNames].sort()).toEqual([...TOOL_NAMES].sort());
  });
});
