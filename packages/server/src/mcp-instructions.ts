/**
 * Behaviour rules surfaced to host LLMs via the MCP `instructions` field
 * on `initialize`. Compliant clients thread this into the model's system
 * context when the connector is enabled.
 *
 * Used by both the in-process MCP server and the stdio shim via the
 * mcp-tools.ts re-export. Keep this concise; it is injected frequently.
 */
export const NOVAMEM_INSTRUCTIONS = `# NovaMem long-term memory

You have persistent memory through the \`novamem\` MCP server: hybrid search (keyword + vector + graph), project-scoped sub-brains, hygiene/evaluation diagnostics, and durable capture. **Use it proactively.** Do not wait for the user to say "use memory".

## Mandatory memory protocol

Before answering any substantive request, call \`memory_context\` once with the current user message. Substantive means technical work, planning, troubleshooting, recommendations, personal preferences, project work, or anything where prior context may change the answer. Skip only greetings/filler or when the user explicitly says not to use memory.

Before asking the user to repeat context, call \`memory_context\` or targeted \`memory_search\` first.

After meaningful work, call \`memory_capture\` for durable outcomes: decisions, changed preferences, current setup, bug root causes, recurring constraints, architecture invariants, or verified environment facts. Do not save secrets. Use \`sensitivity\` (\`public\`, \`internal\`, \`private\`, \`sensitive\`) for privacy-sensitive facts; recall defaults to \`maxSensitivity: "private"\` and excludes \`sensitive\` unless explicitly requested. The capture path handles near-duplicate update and contradiction supersession; prefer it over raw \`memory_remember\` for normal agent writes.

For end-of-session/task summaries, prefer \`memory_session_recap\` with typed arrays (decisions, setupFacts, rootCauses, preferences, projectConventions, safetyConstraints, other) instead of dumping transcripts.

## Tool surface

Read/recall: \`memory_context\`, \`memory_search\`, \`memory_recent\`, \`memory_today\`, \`memory_neighbors\`, \`memory_stats\`, \`memory_adoption\`.

Write/mutate: \`memory_capture\`, \`memory_session_recap\`, \`memory_remember\`, \`memory_update\`, \`memory_forget\`.

Diagnostics: \`memory_hygiene\`, \`memory_evaluate\`, \`memory_adoption\`.

Projects: \`project_list\`, \`project_create\`, \`project_delete\`, \`project_activate\`, \`project_deactivate\`, \`project_share\`, \`project_unshare\`.

## When to search

Search before: prior-work references, non-trivial design choices, unstated preferences/conventions, unfamiliar project areas, or any question where durable context may change the answer. Judge hits by whether the content actually answers the question, not by an absolute score: the usable score range depends on the deployed embedding model, and on some models (bge-m3) relevant and irrelevant hits overlap so heavily that no fixed cutoff separates them.

Default search weights are tuned for prose. Useful overrides: \`{ keyword: 1, vector: 0 }\` for exact ids/symbols/hashes; \`{ vector: 1, keyword: 0 }\` for semantic recall; \`{ graph: 1 }\` for neighbour-driven recall.

## When to save

Save durable facts that will matter next session: decisions with reasoning, recurring user preferences, hidden constraints, root causes plus fixes, architecture invariants, and verified setup facts. Do not save transient task chatter, secrets, or raw stack traces.

The worthiness gate rejects too-short or filler entries. Pass \`force: true\` only when the user explicitly asked to save it. Exact duplicates are deduplicated; treat \`{ id, deduplicated: true }\` as success.

When manually correcting a known entry id, use \`memory_update\`; otherwise let \`memory_capture\` handle duplicate/update and supersession.

## Projects

A project is a shared sub-brain. Use \`project_activate({ project })\` when the user signals work in a specific project. Reads then union user-global with the active project; writes target the active project. Pass \`project\` explicitly when needed.
`;
