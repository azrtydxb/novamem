# 0007 — Remove the deprecated HTTP+SSE transport

Status: accepted
Date: 2026-09-11

## Context

ADR 0006 made the server dual-era, serving the modern `2026-07-28`
revision alongside the legacy handshake on `/mcp`. It left one thing
standing: `GET /mcp/sse` + `POST /mcp/messages?sessionId=…`, the
two-endpoint HTTP+SSE transport from revision `2024-11-05`.

That transport is the only feature novamem shipped that appears in the
spec's [deprecated features
registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated).
Checked against the registry on 2026-09-11, it holds six entries:

| Feature                                 | Deprecated in | Do we ship it?         |
| --------------------------------------- | ------------- | ---------------------- |
| Roots                                   | `2026-07-28`  | no                     |
| Sampling                                | `2026-07-28`  | no                     |
| Logging                                 | `2026-07-28`  | no                     |
| Dynamic Client Registration             | `2026-07-28`  | no                     |
| `includeContext: thisServer/allServers` | `2025-11-25`  | no (part of Sampling)  |
| **HTTP+SSE transport**                  | `2025-03-26`  | **yes — removed here** |

A Deprecated feature remains part of the specification: keeping it was
never a conformance violation, and removing it is not required until
three months after SEP-2596 reaches Final. This is a choice to go first.

The reason to go first is that it is also the one piece of MCP state
that cannot survive a pod moving. `POST /mcp/messages?sessionId=…` has
to reach the goroutine holding that session's open `GET /mcp/sse`
stream — a live in-process object. The signed, adoptable session ids
from ADR 0005 made the streamable transport replica-agnostic; they can
do nothing for this. It worked on the kw cluster only because of a
dedicated Service plus an Ingress annotated
`nginx.ingress.kubernetes.io/upstream-hash-by: "$http_authorization"`,
pinning each bearer to one pod — infrastructure that existed to keep a
deprecated transport breathing, and that lived outside the repo.

## Decision

Remove it. `GET /mcp/sse` and `POST /mcp/messages` are gone from the
route table, the OpenAPI document, the conformance suite and the
`internal/mcp` transport code, together with the second session registry
and the per-session outbound channel that only it used. The affinity
Service and Ingress go with them.

`novamem-init` stops writing `{type: "sse", url: …/mcp/sse}` for remote
hosts and writes `{type: "http", url: …/mcp}` instead (#267). Every
install the old value produced pointed at the transport being removed —
which is why this and #262 could not land separately.

The golden installer fixtures are frozen: they record what the retired
TypeScript installer wrote and cannot be regenerated. The transport
change is applied as a second documented substitution in the golden
test's expectation, alongside the ADR-0001 one, rather than by editing
history in `testdata/`.

## Consequences

- A client still configured for `/mcp/sse` gets the 404 envelope. The
  fix is a two-field config change — `type` to `http`, `url` to `/mcp` —
  and re-running `novamem-init` does it.
- No MCP transport needs load-balancer affinity any more, so replicas
  scale on the strength of ADR 0005 alone. The one remaining obstacle to
  raising `replicas` is `strategy: Recreate` plus the ReadWriteOnce data
  volume.
- The session registry, the idle reaper's second branch, the bounded
  outbound queue and its drop-on-stall path all go. The keepalive loop
  survives, serving the streamable `GET` stream, and no longer relays
  frames: the server emits no notifications and declares
  `listChanged: false`.
- Deliberately still not implemented, and still not required:
  `subscriptions/listen` (a SHOULD only for servers declaring
  `listChanged: true`), MRTR / `InputRequiredResult` (a MAY), and
  `x-mcp-header` (an optional annotation whose MUSTs bind clients). Each
  becomes required only if the corresponding feature is added.
- `outputSchema` remains absent on all 21 tools. The spec calls it
  optional — "Servers **MUST** provide structured results that conform
  to this schema" applies only _if_ one is declared — so this is a
  quality gap rather than a compliance one, tracked in #266.

## Supersedes

Nothing. Extends ADR 0006, which made the dual-era decision and left the
SSE pair explicitly out of scope ("retiring it is separate work").
