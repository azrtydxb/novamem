---
title: Custom HTTP integration
---

# Custom HTTP integration

If your tool isn't an MCP host, you can still talk to novamem over plain JSON HTTP. Same surface as the MCP tools, just over `POST /v1/*` with a bearer header.

## Authenticate

Mint a tenant token from the dashboard (or via [`POST /v1/me/tokens`](../api/auth.md)) and send it as a bearer:

```bash
curl -H "Authorization: Bearer nm_..." \
     https://novamem.example.com/health
```

## Remember an entry

```bash
curl -X POST https://novamem.example.com/v1/remember \
  -H "Authorization: Bearer nm_..." \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Decision: Postgres for the main store. MVCC + extensibility.",
    "namespace": "decisions",
    "sourceType": "doc"
  }'
```

Response:

```json
{ "id": "01KQW8EKAJYNTVSGA283SF2ZGQ" }
```

## Search hybrid

```bash
curl -X POST https://novamem.example.com/v1/search \
  -H "Authorization: Bearer nm_..." \
  -H "Content-Type: application/json" \
  -d '{
    "query": "why did we pick Postgres",
    "k": 5
  }'
```

Override `weights` to force keyword-only or vector-only:

```json
{ "query": "ABC123", "weights": { "keyword": 1, "vector": 0, "graph": 0 } }
```

## Walk the graph

```bash
curl -X POST https://novamem.example.com/v1/neighbors \
  -H "Authorization: Bearer nm_..." \
  -H "Content-Type: application/json" \
  -d '{ "id": "01KQW8EKAJYNTVSGA283SF2ZGQ", "depth": 2, "k": 10 }'
```

## SDK

A typed TypeScript client lives at [`@azrtydxb/novamem`](https://www.npmjs.com/package/@azrtydxb/novamem):

```ts
import { NovaMemClient } from "@azrtydxb/novamem";

const nm = new NovaMemClient({
  baseUrl: "https://novamem.example.com",
  token: process.env.NOVAMEM_TOKEN,
});

await nm.remember({ content: "...", namespace: "decisions" });
const r = await nm.search({ query: "why did we pick Postgres" });
```

See [API → Data plane](../api/data-plane.md) for the full route list.
