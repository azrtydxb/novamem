# novamem

Standalone tiered memory service for AI agents.

- **Warm/Cold tiers** with synaptic decay (`effectiveDays = 7 × log₂(hits + 1)`)
- **Hybrid search**: keyword (Postgres FTS) + vector cosine (Qdrant) + graph neighbours (FalkorDB) — fused with min-max-normalized weighted scoring
- **Two transports**: HTTP/JSON API and MCP (stdio + SSE)
- **Storage**: Postgres (warm) · Qdrant (cold) · FalkorDB (graph, optional — degrades gracefully when unreachable)
- **Pluggable embeddings**: any OpenAI-compatible endpoint, or local via `@xenova/transformers` (default — no external API keys)

## Packages

- [`@azrty/novamem-server`](packages/server) — the standalone service (HTTP + MCP transports)
- [`@azrty/novamem`](packages/client) — TypeScript client + public types
- [`@azrty/novamem-mcp`](packages/mcp) — MCP-stdio shim binary

## Quickstart

```bash
docker compose up -d
curl http://localhost:5050/health
```

Default ports: HTTP **5050** (host) → 5000 (container). Postgres on 5432, Qdrant on 6333, FalkorDB on 6379.

The compose stack boots Postgres, Qdrant, FalkorDB, and the memory server with local embeddings — no external API keys required.

### Use from any TypeScript agent

```ts
import { NovamemClient } from "@azrty/novamem";

const memory = new NovamemClient({ baseUrl: "http://localhost:5050" });
await memory.remember({ content: "The user prefers dark roast.", namespace: "default" });
const hits = await memory.search({ query: "coffee preference", k: 5 });
```

### Mount as an MCP tool — stdio

For local MCP-aware hosts (Claude Desktop, Cursor, Cline, Claude Code):

```json
{
  "mcpServers": {
    "novamem": {
      "command": "npx",
      "args": ["@azrty/novamem-mcp"],
      "env": { "NOVAMEM_BASE_URL": "http://localhost:5050" }
    }
  }
}
```

### Mount as an MCP tool — SSE

For remote MCP hosts that prefer HTTP+SSE transport, the server itself exposes:

- `GET /mcp/sse` — opens the SSE event stream and returns a `sessionId`
- `POST /mcp/messages?sessionId=<id>` — sends JSON-RPC requests

Hosts that support SSE-MCP (e.g. some claude.ai integrations, custom agents) point at `http://<host>:5050/mcp/sse` directly — no shim needed.

## API surface

HTTP endpoints (also exposed as MCP tools `memory.<verb>`):

- `POST /v1/search` — hybrid search; optional `weights` override per call
- `POST /v1/remember` — store an entry
- `POST /v1/recent` — newest entries in a namespace, optional `since` ISO-8601
- `POST /v1/neighbors` — graph traversal from a seed memory id
- `POST /v1/forget` — explicit deletion (warm + FTS + cold + graph edges)
- `POST /v1/decay` — run the demotion pass on demand
- `GET /v1/stats` — per-namespace counts, last decay timestamp
- `GET /health` — liveness + dependency snapshot

## Status

Pre-1.0. API may change between minor versions until 1.0.

## License

MIT
