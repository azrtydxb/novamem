# Go MCP stdio shim binary

Status: done 2026-08-20
Created: 2026-08-20
Epic: mcp-shim-to-go
Sprint: 002-server-module-gated-and-soak-proven-the-mcp-stdio-shim

## Description

go/cmd/novamem-mcp: a pure transport bridge — every JSON-RPC message
from stdin is relayed to {base}/mcp and the response returned, so tool
schemas, instructions, and behaviour are always exactly what the server
serves. This deliberately replaces the TS shim's design (a hand-synced
mirror of all 21 tool definitions plus REST dispatch): during the port
the mirror was found ALREADY DRIFTED from the server's canonical
definitions (stale descriptions and annotations, e.g. memory_stats), so
"byte-identical to the TS shim" was retired as the oracle — the server
surface itself is the contract, and the original criteria were rewritten
accordingly (not weakened: the canonical oracle is stricter).

## Acceptance criteria

- [x] bridge tools/list is byte-identical (key-sorted JSON) to the server's own streamable-HTTP tools/list AND to the embedded canonical go/internal/mcp/tooldefs.json — 21 tools
- [x] real tool calls round-trip through the bridge against a live server (memory_remember → memory_search finds it → memory_stats)
- [x] a real stdio MCP host drives the bridge end-to-end
- [x] same env vars honored as the TS shim documents (NOVAMEM_BASE_URL, NOVAMEM_TOKEN)
- [x] unit tests cover session establishment/serialization, notification silence, teardown DELETE, transport-failure RPC errors, and SSE frame parsing

## Evidence

- byte-identity: probe script diffed key-sorted tools/list from bridge vs direct HTTP vs tooldefs.json → both True (2026-08-20); the TS shim's mirror differs on every tool (stale) — drift recorded in the story description
- live calls: remember/search/stats through the bridge against the local pgvector rig — all isError:false, search scored the written probe 0.9999
- real host: Claude Code CLI `-p --mcp-config` with the bridge as a stdio server called memory_stats and reported TOTALWARM=61
- `go test ./cmd/novamem-mcp/` green (handshake+session+teardown, transport-failure envelope, SSE extraction); golangci-lint clean; covered by the CI go job's build/test/lint
- follow-ups ride existing stories: host-config switchover + packages/mcp deletion belong to the distribution ADR execution (20260820-retire-npm-release-machinery / init CLI port)

