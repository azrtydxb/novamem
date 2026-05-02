# novamem

Standalone tiered memory service for AI agents.

- **Hot/Warm/Cold tiers** with synaptic decay (`effectiveDays = 7 × log2(hits + 1)`)
- **Hybrid search**: keyword (FTS) + vector cosine + graph neighbors
- **Two transports**: HTTP/JSON API and MCP (stdio + SSE)
- **Pluggable storage**: Postgres or SQLite (warm) · Qdrant (cold) · FalkorDB (graph, optional)
- **Pluggable embeddings**: any OpenAI-compatible endpoint, or local via `@xenova/transformers`

## Packages

- [`@azrty/novamem-server`](packages/server) — the standalone service (HTTP + MCP transports)
- [`@azrty/novamem`](packages/client) — TypeScript client + public types
- [`@azrty/novamem-mcp`](packages/mcp) — MCP-stdio shim binary

## Quickstart

```bash
docker compose up -d
curl http://localhost:5000/health
```

The default compose stack boots Postgres, Qdrant, FalkorDB, and the memory server with local embeddings (`@xenova/transformers`) — no external API keys required.

### Use from any TypeScript agent

```ts
import { NovamemClient } from "@azrty/novamem";

const memory = new NovamemClient({ baseUrl: "http://localhost:5000" });
await memory.remember({ content: "The user prefers dark roast.", namespace: "default" });
const hits = await memory.search({ query: "coffee preference", k: 5 });
```

### Mount as an MCP tool

Add to your MCP config (Claude Desktop, Cursor, Cline, etc.):

```json
{
  "mcpServers": {
    "novamem": {
      "command": "npx",
      "args": ["@azrty/novamem-mcp"],
      "env": { "NOVAMEM_BASE_URL": "http://localhost:5000" }
    }
  }
}
```

## Status

Pre-1.0. API may change between minor versions until 1.0.

## License

MIT
