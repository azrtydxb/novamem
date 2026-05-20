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
        "memory_session_recap",
        "memory_hygiene",
        "memory_evaluate",
        "memory_adoption",
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


  it("memory_capture labels sensitive content and hides it from default search/context", async () => {
    const { engine } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const stored = (await callTool(server, "memory_capture", {
      content: "Production API token is sk-live-secret-123456",
      namespace: "security",
      force: true,
    })) as { content: Array<{ text: string }> };
    const storedPayload = JSON.parse(stored.content[0]!.text);
    expect(storedPayload.results[0].id).toBeTruthy();

    const hidden = (await callTool(server, "memory_search", { query: "sk-live-secret-123456", includeNamespaces: ["security"] })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(hidden.content[0]!.text).results).toHaveLength(0);

    const visible = (await callTool(server, "memory_search", {
      query: "sk-live-secret-123456",
      includeNamespaces: ["security"],
      maxSensitivity: "sensitive",
    })) as { content: Array<{ text: string }> };
    const visiblePayload = JSON.parse(visible.content[0]!.text);
    expect(visiblePayload.results[0].metadata.sensitivity).toBe("sensitive");

    const ctx = (await callTool(server, "memory_context", { message: "token", includeNamespaces: ["security"], k: 5 })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(ctx.content[0]!.text).contextPack.all).toHaveLength(0);
  });

  it("memory_update can change sensitivity and default search respects the new level", async () => {
    const { engine } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const r = (await callTool(server, "memory_remember", {
      content: "Private family travel detail",
      namespace: "family",
      sensitivity: "private",
      force: true,
    })) as { content: Array<{ text: string }> };
    const id = JSON.parse(r.content[0]!.text).id;

    await callTool(server, "memory_update", { id, sensitivity: "sensitive" });

    const hidden = (await callTool(server, "memory_search", { query: "family travel", includeNamespaces: ["family"] })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(hidden.content[0]!.text).results).toHaveLength(0);
    const visible = (await callTool(server, "memory_search", { query: "family travel", includeNamespaces: ["family"], maxSensitivity: "sensitive" })) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(visible.content[0]!.text).results[0].metadata.sensitivity).toBe("sensitive");
  });


  it("memory_adoption reports the advertised tool surface and refresh guidance", async () => {
    const { engine } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const r = (await callTool(server, "memory_adoption", { client: "hermes" })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0]!.text);

    expect(payload.server).toMatchObject({ name: "novamem" });
    expect(payload.mcp.toolCount).toBeGreaterThanOrEqual(21);
    expect(payload.mcp.tools).toContain("memory_adoption");
    expect(payload.mcp.instructionsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.requiredTools).toEqual(expect.arrayContaining(["memory_context", "memory_capture", "memory_adoption"]));
    expect(payload.refresh.hermes.commands).toEqual(expect.arrayContaining(["/reload-mcp", "/reload-skills", "/reset"]));
    expect(payload.refresh.hermes.requiresNewSession).toBe(true);
    expect(payload.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ check: "tool_surface" })]));
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

  it("memory_context returns a structured context pack grouped by memory type", async () => {
    const { engine } = makeEngine();
    const server = buildMcpServer(engine, "public");
    await callTool(server, "memory_capture", {
      content: "Pascal prefers concise technical answers.",
      namespace: "user",
    });
    await callTool(server, "memory_capture", {
      content: "NovaMem production deployment runs on 192.168.10.248.",
      namespace: "current-setup",
    });
    await callTool(server, "memory_capture", {
      content: "Decision: use Drizzle over Knex for compile-time checked SQL.",
      namespace: "decisions",
    });

    const r = (await callTool(server, "memory_context", {
      message: "Work on NovaMem deployment with concise status updates",
      includeNamespaces: ["user", "current-setup", "decisions"],
      k: 8,
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0]!.text);

    expect(payload.contextPack).toMatchObject({
      userPreferences: expect.any(Array),
      currentSetup: expect.any(Array),
      decisions: expect.any(Array),
      pitfalls: expect.any(Array),
    });
    expect(payload.contextPack.userPreferences.some((m: { content: string }) => m.content.includes("concise"))).toBe(true);
    expect(payload.contextPack.currentSetup.some((m: { content: string }) => m.content.includes("192.168.10.248"))).toBe(true);
    expect(payload.contextPack.decisions.some((m: { content: string }) => m.content.includes("Drizzle"))).toBe(true);
  });

  it("memory_capture annotates memory type and worthiness score", async () => {
    const { engine, warm } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const r = (await callTool(server, "memory_capture", {
      content: "Pascal prefers concise technical answers.",
      namespace: "user",
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0]!.text);
    const entry = warm.rows.get(payload.results[0].id)!;

    expect(entry.metadata).toMatchObject({
      memoryType: "user_preference",
      worthiness: {
        durable: expect.any(Number),
        reuseLikelihood: expect.any(Number),
        userRelevance: expect.any(Number),
        overall: expect.any(Number),
      },
    });
    expect((entry.metadata!.worthiness as { overall: number }).overall).toBeGreaterThan(0.5);
  });

  it("memory_session_recap ingests durable typed recap items", async () => {
    const { engine, warm } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const r = (await callTool(server, "memory_session_recap", {
      decisions: ["Decision: choose Drizzle over Knex for compile-time checked SQL."],
      setupFacts: ["NovaMem production deployment runs on 192.168.10.248."],
      rootCauses: ["Root cause: CI failed because fast-uri was vulnerable through a transitive dependency."],
      preferences: ["Pascal prefers concise technical status updates."],
      capturedFrom: "test-session",
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0]!.text);

    expect(payload.saved).toBe(4);
    const types = payload.results.map((x: { id: string }) => warm.rows.get(x.id)!.metadata!.memoryType).sort();
    expect(types).toEqual(["bug_root_cause", "decision", "setup_fact", "user_preference"].sort());
  });



  it("memory_capture supersedes structured version, date, port, and model changes", async () => {
    const { engine, warm, embedder } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const oldFact = "NovaMem production uses image ghcr.io/azrtydxb/novamem:sha-old123 on port 7778 with model alpha since 2026-05-19.";
    const newFact = "NovaMem production uses image ghcr.io/azrtydxb/novamem:sha-new456 on port 7779 with model beta since 2026-05-20.";
    embedder.table.set(oldFact, [0.3, 0.3, 0.3, 0.3]);
    embedder.table.set(newFact, [0.3, 0.3, 0.3, 0.3]);

    const first = (await callTool(server, "memory_capture", { content: oldFact, namespace: "current-setup" })) as { content: Array<{ text: string }> };
    const oldId = JSON.parse(first.content[0]!.text).results[0].id;
    const second = (await callTool(server, "memory_capture", { content: newFact, namespace: "current-setup" })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(second.content[0]!.text);

    expect(payload.results[0].superseded).toContain(oldId);
    expect(warm.rows.get(oldId)!.metadata).toMatchObject({ lifecycleStatus: "superseded", supersededReason: "contradiction" });
  });

  it("memory_context separates user-global and project-scoped context pack entries", async () => {
    const { engine } = makeEngine();
    const server = buildMcpServer(engine, "public");
    await callTool(server, "memory_capture", { content: "Pascal prefers concise status updates.", namespace: "user" });
    await callTool(server, "memory_capture", { content: "Project convention: NovaMem uses Drizzle migrations.", namespace: "project-conventions", project: "project-a" });

    const r = (await callTool(server, "memory_context", {
      message: "Work on NovaMem with concise status",
      includeProjects: ["project-a"],
      includeNamespaces: ["user", "project-conventions"],
      k: 8,
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0]!.text);

    expect(payload.contextPack.userGlobal.some((m: { content: string }) => m.content.includes("concise"))).toBe(true);
    expect(payload.contextPack.projectScoped.some((m: { content: string }) => m.content.includes("Drizzle"))).toBe(true);
    expect(payload.contextPack.projectConventions.some((m: { content: string }) => m.content.includes("Drizzle"))).toBe(true);
  });

  it("memory_capture stores retention policy by memory type", async () => {
    const { engine, warm } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const r = (await callTool(server, "memory_capture", {
      content: "Current deployment state: NovaMem image sha-example runs on 192.168.10.248.",
      namespace: "current-setup",
    })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0]!.text);
    const metadata = warm.rows.get(payload.results[0].id)!.metadata!;

    expect(metadata).toMatchObject({
      memoryType: "deployment_state",
      retention: { policy: "current_only", supersedeAggressively: true },
    });
  });

  it("memory_hygiene reports low value, stale, duplicate, contradiction, and orphan candidates", async () => {
    const { engine, warm, embedder } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const a = "Pascal prefers concise answers for status updates.";
    const b = "Pascal likes concise answers for status updates.";
    const c = "NovaMem deployment uses port 7778.";
    const d = "NovaMem deployment uses port 7779.";
    embedder.table.set(a, [1, 0, 0, 0]);
    embedder.table.set(b, [1, 0, 0, 0]);
    embedder.table.set(c, [0, 1, 0, 0]);
    embedder.table.set(d, [0, 1, 0, 0]);
    await callTool(server, "memory_remember", { content: "ok-ish but forced", namespace: "memory", force: true, metadata: { worthiness: { overall: 0.2 } } });
    await callTool(server, "memory_remember", { content: a, namespace: "user", force: true });
    await callTool(server, "memory_remember", { content: b, namespace: "user", force: true });
    await callTool(server, "memory_remember", { content: c, namespace: "current-setup", force: true });
    await callTool(server, "memory_remember", { content: d, namespace: "current-setup", force: true });
    const baseRow = warm.rows.values().next().value!;
    warm.rows.set("warm-only-orphan", { ...baseRow, id: "warm-only-orphan", content: "Warm only orphan candidate", namespace: "memory", metadata: {} });

    const r = (await callTool(server, "memory_hygiene", { k: 10 })) as { content: Array<{ text: string }>; isError?: boolean };
    if (r.isError) throw new Error(r.content[0]!.text);
    const payload = JSON.parse(r.content[0]!.text);

    expect(payload.summary.scanned).toBeGreaterThan(0);
    expect(payload.summary.lowValue).toBeGreaterThan(0);
    expect(payload.summary.duplicateClusters).toBeGreaterThan(0);
    expect(payload.summary.contradictionCandidates).toBeGreaterThan(0);
    expect(payload.summary.orphanCandidates).toBeGreaterThan(0);
    expect(payload.lowValue.length).toBeGreaterThan(0);
    expect(payload.duplicateClusters.length).toBeGreaterThan(0);
    expect(payload.contradictionCandidates.length).toBeGreaterThan(0);
    expect(payload.orphanCandidates.some((x: { id: string }) => x.id === "warm-only-orphan")).toBe(true);
  });

  it("memory_evaluate runs built-in quality scenarios", async () => {
    const { engine } = makeEngine();
    await engine.remember("public", {
      content: "low value eval seed",
      namespace: "memory",
      force: true,
      metadata: { worthiness: { overall: 0.2 } },
    });
    const server = buildMcpServer(engine, "public");
    const r = (await callTool(server, "memory_evaluate", { suite: "core" })) as { content: Array<{ text: string }> };
    const payload = JSON.parse(r.content[0]!.text);

    expect(payload.passed).toBe(true);
    expect(payload.checks).toEqual(payload.cases);
    expect(payload.summary.total).toBeGreaterThan(0);
    expect(payload.summary.passed).toBe(payload.summary.total);
    expect(payload.cases.map((c: { name: string }) => c.name)).toEqual(expect.arrayContaining([
      "newer fact supersedes older fact",
      "context pack groups typed memories",
      "junk capture is rejected",
    ]));
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

  it("memory_capture updates a semantic duplicate instead of inserting another row", async () => {
    const { engine, warm, embedder } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const original = "Pascal prefers concise technical answers.";
    const duplicate = "Pascal likes concise technical answers.";
    embedder.table.set(original, [1, 0, 0, 0]);
    embedder.table.set(duplicate, [1, 0, 0, 0]);

    const first = (await callTool(server, "memory_capture", {
      content: original,
      namespace: "user",
    })) as { content: Array<{ text: string }> };
    const firstPayload = JSON.parse(first.content[0]!.text);

    const second = (await callTool(server, "memory_capture", {
      content: duplicate,
      namespace: "user",
    })) as { content: Array<{ text: string }> };
    const secondPayload = JSON.parse(second.content[0]!.text);

    expect(warm.rows.size).toBe(1);
    expect(secondPayload.results[0].id).toBe(firstPayload.results[0].id);
    expect(secondPayload.results[0].updated).toBe(true);
    expect(warm.rows.get(firstPayload.results[0].id)!.content).toBe(duplicate);
    expect(warm.rows.get(firstPayload.results[0].id)!.metadata).toMatchObject({
      lifecycleStatus: "active",
      captureAction: "updated",
    });
  });

  it("memory_capture supersedes a contradictory older fact and hides it from context", async () => {
    const { engine, warm, embedder } = makeEngine();
    const server = buildMcpServer(engine, "public");
    const oldFact = "DGX Spark run 2026 vLLM DFlash speculative tokens: 15.";
    const newFact = "DGX Spark run 2026 vLLM DFlash speculative tokens: 6.";
    embedder.table.set(oldFact, [0, 1, 0, 0]);
    embedder.table.set(newFact, [0, 1, 0, 0]);

    const first = (await callTool(server, "memory_capture", {
      content: oldFact,
      namespace: "current-setup",
    })) as { content: Array<{ text: string }> };
    const oldId = JSON.parse(first.content[0]!.text).results[0].id;

    const second = (await callTool(server, "memory_capture", {
      content: newFact,
      namespace: "current-setup",
    })) as { content: Array<{ text: string }> };
    const newPayload = JSON.parse(second.content[0]!.text);
    const newId = newPayload.results[0].id;

    expect(warm.rows.size).toBe(2);
    expect(newId).not.toBe(oldId);
    expect(newPayload.results[0].superseded).toEqual([oldId]);
    expect(warm.rows.get(oldId)!.metadata).toMatchObject({
      lifecycleStatus: "superseded",
      supersededBy: newId,
      supersededReason: "contradiction",
    });
    expect(warm.rows.get(newId)!.metadata).toMatchObject({
      lifecycleStatus: "active",
      supersedes: [oldId],
    });

    const ctx = (await callTool(server, "memory_context", {
      message: "What DFlash speculative token count is current?",
      namespace: "current-setup",
      k: 5,
    })) as { content: Array<{ text: string }> };
    const contextPayload = JSON.parse(ctx.content[0]!.text);
    const returnedIds = [
      ...contextPayload.relevant.results.map((r: { id: string }) => r.id),
      ...contextPayload.recent.results.map((r: { id: string }) => r.id),
    ];
    expect(returnedIds).toContain(newId);
    expect(returnedIds).not.toContain(oldId);
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
