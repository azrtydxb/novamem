/**
 * MCP server exposing memory tools via stdio. The same engine instance backs
 * both HTTP and MCP — tool semantics are identical.
 *
 * The tool advertisement (`tools/list`), instruction text, Zod input
 * schemas, and the active-project scope-resolution helper all live in
 * `./mcp-tools.ts` so the stdio shim
 * (`packages/mcp/src/index.ts`) and this in-process server stay in sync.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { MemoryEngine } from "./engine/index.js";
import type { WarmStore } from "./warm-store/index.js";
import {
  NOVAMEM_INSTRUCTIONS,
  TOOL_DEFINITIONS,
  parseToolArgs,
  resolveScope,
} from "./mcp-tools.js";
import { buildAdoptionReport } from "./adoption.js";

export interface McpContext {
  /** Memory-owner id — the user the caller's bearer maps to. */
  userId: string;
  /** Project the bearer/session is bound to (or null for whole-user). */
  projectId?: string | null;
}

/** Build the MCP server. `ctxOrUserId` accepts either a context object
 *  (new shape with user + optional project) or a bare userId string for
 *  back-compat with existing callers. */
export function buildMcpServer(
  engine: MemoryEngine,
  ctxOrUserId: McpContext | string,
  warm?: WarmStore,
): Server {
  const ctx: McpContext =
    typeof ctxOrUserId === "string" ? { userId: ctxOrUserId } : ctxOrUserId;
  const userId = ctx.userId;
  const server = new Server(
    { name: "novamem", version: "0.1.0" },
    {
      // listChanged: false — our tool list is static across the
      // process lifetime, so we never emit notifications/tools/list_changed.
      // Spec § "Capability Negotiation" lets us say so explicitly.
      capabilities: { tools: { listChanged: false } },
      instructions: NOVAMEM_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const rawArgs = req.params.arguments ?? {};
    try {
      switch (name) {
        case "memory_context": {
          const args = parseToolArgs("memory_context", rawArgs);
          const scope = await resolveScope(warm, userId, {
            project: args.project ?? undefined,
            includeProjects: args.includeProjects,
            unionWithActive: true,
          });
          const k = args.k ?? 8;
          const [relevant, recent] = await Promise.all([
            engine.search(userId, {
              query: args.message,
              k,
              namespace: args.namespace,
              includeNamespaces: args.includeNamespaces,
              project: scope.project,
              includeProjects: scope.includeProjects,
              weights: args.weights,
              maxSensitivity: args.maxSensitivity,
            }),
            engine.recent(userId, {
              k: Math.min(k, 10),
              namespace: args.namespace,
              includeNamespaces: args.includeNamespaces,
              project: scope.project,
              includeProjects: scope.includeProjects,
              maxSensitivity: args.maxSensitivity,
            }),
          ]);
          const contextPack = engine.buildContextPack(relevant.results, recent.results);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                relevant,
                recent,
                contextPack,
                guidance: "Use this context before answering. Prefer contextPack sections over loose hits. If relevant is empty, run targeted memory_search before asking the user to repeat context.",
              }),
            }],
          };
        }
        case "memory_capture": {
          const args = parseToolArgs("memory_capture", rawArgs);
          const scope = await resolveScope(warm, userId, {
            project: args.project ?? undefined,
            unionWithActive: false,
          });
          const r = await engine.capture(userId, {
            content: args.content,
            namespace: args.namespace,
            source: args.source ?? "memory_capture",
            agentName: args.agentName,
            metadata: args.metadata,
            sourceType: args.sourceType ?? "chat",
            capturedFrom: args.capturedFrom ?? "memory_capture",
            confidence: args.confidence,
            force: args.force,
            sensitivity: args.sensitivity,
            project: scope.project,
          });
          return { content: [{ type: "text", text: JSON.stringify({ saved: r.id ? 1 : 0, results: [r] }) }] };
        }
        case "memory_session_recap": {
          const args = parseToolArgs("memory_session_recap", rawArgs);
          const scope = await resolveScope(warm, userId, {
            project: args.project ?? undefined,
            unionWithActive: false,
          });
          const groups: Array<{ items?: string[]; namespace: string; memoryType: string }> = [
            { items: args.decisions, namespace: "decisions", memoryType: "decision" },
            { items: args.setupFacts, namespace: "current-setup", memoryType: "setup_fact" },
            { items: args.rootCauses, namespace: "root-causes", memoryType: "bug_root_cause" },
            { items: args.preferences, namespace: "user", memoryType: "user_preference" },
            { items: args.projectConventions, namespace: "project-conventions", memoryType: "project_convention" },
            { items: args.safetyConstraints, namespace: "safety", memoryType: "safety_constraint" },
            { items: args.other, namespace: args.namespace ?? "memory", memoryType: "general" },
          ];
          const results = [];
          for (const group of groups) {
            for (const content of group.items ?? []) {
              const r = await engine.capture(userId, {
                content,
                namespace: args.namespace ?? group.namespace,
                source: args.source ?? "memory_session_recap",
                agentName: args.agentName,
                metadata: { ...(args.metadata ?? {}), memoryType: group.memoryType, recap: true },
                sourceType: args.sourceType ?? "summary",
                capturedFrom: args.capturedFrom ?? "memory_session_recap",
                confidence: args.confidence,
                force: args.force,
                sensitivity: args.sensitivity,
                project: scope.project,
              });
              results.push(r);
            }
          }
          return { content: [{ type: "text", text: JSON.stringify({ saved: results.filter((r) => r.id).length, results }) }] };
        }
        case "memory_hygiene": {
          const args = parseToolArgs("memory_hygiene", rawArgs);
          const r = await engine.hygieneReport(userId, { k: args.k });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_evaluate": {
          const args = parseToolArgs("memory_evaluate", rawArgs);
          const r = await engine.evaluateMemoryQuality(userId, { suite: args.suite });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }

        case "memory_adoption": {
          const args = parseToolArgs("memory_adoption", rawArgs);
          const r = buildAdoptionReport(args);
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_search": {
          const args = parseToolArgs("memory_search", rawArgs);
          const scope = await resolveScope(warm, userId, {
            project: args.project ?? undefined,
            includeProjects: args.includeProjects,
            unionWithActive: true,
          });
          const r = await engine.search(userId, {
            query: args.query,
            k: args.k,
            namespace: args.namespace,
            includeNamespaces: args.includeNamespaces,
            project: scope.project,
            includeProjects: scope.includeProjects,
            weights: args.weights,
            maxSensitivity: args.maxSensitivity,
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_remember": {
          const args = parseToolArgs("memory_remember", rawArgs);
          const scope = await resolveScope(warm, userId, {
            project: args.project ?? undefined,
            unionWithActive: false,
          });
          const r = await engine.remember(userId, {
            content: args.content,
            namespace: args.namespace,
            source: args.source,
            sourceType: args.sourceType,
            capturedFrom: args.capturedFrom,
            confidence: args.confidence,
            force: args.force,
            sensitivity: args.sensitivity,
            project: scope.project,
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_today": {
          const args = parseToolArgs("memory_today", rawArgs);
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const scope = await resolveScope(warm, userId, {
            project: args.project ?? undefined,
            includeProjects: args.includeProjects,
            unionWithActive: true,
          });
          const r = await engine.recent(userId, {
            namespace: args.namespace,
            includeNamespaces: args.includeNamespaces,
            k: args.k ?? 20,
            since,
            project: scope.project,
            includeProjects: scope.includeProjects,
            maxSensitivity: args.maxSensitivity,
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_recent": {
          const args = parseToolArgs("memory_recent", rawArgs);
          const scope = await resolveScope(warm, userId, {
            project: args.project ?? undefined,
            includeProjects: args.includeProjects,
            unionWithActive: true,
          });
          const r = await engine.recent(userId, {
            namespace: args.namespace,
            includeNamespaces: args.includeNamespaces,
            k: args.k,
            since: args.since,
            project: scope.project,
            includeProjects: scope.includeProjects,
            maxSensitivity: args.maxSensitivity,
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_neighbors": {
          const args = parseToolArgs("memory_neighbors", rawArgs);
          const scope = await resolveScope(warm, userId, {
            project: args.project ?? undefined,
            includeProjects: args.includeProjects,
            unionWithActive: true,
          });
          const r = await engine.neighbors(userId, {
            id: args.id,
            depth: args.depth,
            k: args.k,
            project: scope.project,
            includeProjects: scope.includeProjects,
            maxSensitivity: args.maxSensitivity,
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_forget": {
          const args = parseToolArgs("memory_forget", rawArgs);
          const scope = await resolveScope(warm, userId, {
            project: args.project ?? undefined,
            unionWithActive: false,
          });
          const r = await engine.forget(userId, args.id, {
            project: scope.project,
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_update": {
          const args = parseToolArgs("memory_update", rawArgs);
          const scope = await resolveScope(warm, userId, {
            project: args.project ?? undefined,
            unionWithActive: false,
          });
          const r = await engine.update(userId, args.id, {
            content: args.content,
            namespace: args.namespace,
            metadata: args.metadata,
            sourceType: args.sourceType,
            capturedFrom: args.capturedFrom,
            confidence: args.confidence,
            sensitivity: args.sensitivity,
            project: scope.project,
          });
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "memory_stats": {
          const r = await engine.stats(userId);
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "project_list": {
          if (!warm) throw new Error("project_list requires the warm store");
          // Tokens have no project scope — any authenticated caller lists
          // projects owned-or-joined by their underlying user.
          const projects = await warm.listProjectsForUser(userId);
          return { content: [{ type: "text", text: JSON.stringify({ projects }) }] };
        }
        case "project_create": {
          if (!warm) throw new Error("project_create requires the warm store");
          const args = parseToolArgs("project_create", rawArgs);
          const project = await warm.createProject({
            name: args.name,
            ownerUserId: userId,
          });
          return { content: [{ type: "text", text: JSON.stringify(project) }] };
        }
        case "project_delete": {
          if (!warm) throw new Error("project_delete requires the warm store");
          const args = parseToolArgs("project_delete", rawArgs);
          const scope = await resolveScope(warm, userId, {
            project: args.project,
            unionWithActive: false,
          });
          if (!scope.project) throw new Error("project required");
          const project = await warm.getProject(scope.project);
          if (!project) throw new Error("unknown project");
          if (project.ownerUserId !== userId) {
            throw new Error("only the owner can delete a project");
          }
          const r = await engine.deleteProject(scope.project, project.ownerUserId);
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        case "project_activate": {
          if (!warm) throw new Error("project_activate requires the warm store");
          const args = parseToolArgs("project_activate", rawArgs);
          const scope = await resolveScope(warm, userId, {
            project: args.project,
            unionWithActive: false,
          });
          if (!scope.project) throw new Error("project required");
          await warm.setActiveProject(userId, scope.project);
          return {
            content: [{ type: "text", text: JSON.stringify({ active: scope.project }) }],
          };
        }
        case "project_deactivate": {
          if (!warm) throw new Error("project_deactivate requires the warm store");
          await warm.setActiveProject(userId, null);
          return { content: [{ type: "text", text: JSON.stringify({ active: null }) }] };
        }
        case "project_share": {
          if (!warm) throw new Error("project_share requires the warm store");
          const args = parseToolArgs("project_share", rawArgs);
          const scope = await resolveScope(warm, userId, {
            project: args.project,
            unionWithActive: false,
          });
          if (!scope.project) throw new Error("project required");
          const project = await warm.getProject(scope.project);
          if (!project) throw new Error("unknown project");
          if (project.ownerUserId !== userId) {
            throw new Error("only the owner can share a project");
          }
          // Exact email only. `findUserByUsername` also matches on the
          // self-settable `name` column and on the email local-part, so a
          // newly-registered attacker could set their display name to a
          // target's handle and be invited into the project in their
          // place — with full read+write over every memory in it. The
          // HTTP route (routes/me.ts) was hardened against exactly this;
          // this path had been left on the fuzzy resolver.
          const target = await warm.findUserByExactEmail(args.username);
          if (!target) {
            throw new Error(
              `unknown user '${args.username}' — share by exact email address`,
            );
          }
          const ok = await warm.addProjectMember(scope.project, target.id, "member");
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  added: ok,
                  userId: target.id,
                  username: target.username,
                }),
              },
            ],
          };
        }
        case "project_unshare": {
          if (!warm) throw new Error("project_unshare requires the warm store");
          const args = parseToolArgs("project_unshare", rawArgs);
          const scope = await resolveScope(warm, userId, {
            project: args.project,
            unionWithActive: false,
          });
          if (!scope.project) throw new Error("project required");
          const project = await warm.getProject(scope.project);
          if (!project) throw new Error("unknown project");
          if (project.ownerUserId !== userId) {
            throw new Error("only the owner can unshare a project");
          }
          // Exact email only — see the note on project_share above. An
          // ambiguous display-name match here would remove the wrong
          // member.
          const target = await warm.findUserByExactEmail(args.username);
          if (!target) {
            throw new Error(
              `unknown user '${args.username}' — unshare by exact email address`,
            );
          }
          if (target.id === project.ownerUserId) {
            throw new Error(
              "the owner cannot unshare themselves — delete the project instead",
            );
          }
          const r = await warm.removeProjectMember(scope.project, target.id);
          return { content: [{ type: "text", text: JSON.stringify(r) }] };
        }
        default:
          return {
            content: [{ type: "text", text: `unknown tool: ${name}` }],
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

export async function startMcpStdio(engine: MemoryEngine, userId: string): Promise<void> {
  const server = buildMcpServer(engine, userId);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Re-export for any external consumer that previously imported from here.
export { NOVAMEM_INSTRUCTIONS } from "./mcp-tools.js";
