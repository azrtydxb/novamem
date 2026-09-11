# 0008 — Conformance audit against MCP 2026-07-28

Status: accepted
Date: 2026-09-11

## Context

ADR 0006 made the server dual-era and ADR 0007 removed the one Deprecated
feature it shipped. Neither answered the question directly: is this
server actually conformant? "It works with every client we have tried"
is not the same claim, and the gap between them is exactly where silent
incompatibility lives.

So: every server-binding **MUST** in revision `2026-07-28`, read from the
published spec rather than recalled, checked against what the code does.
Pages audited — base protocol, Streamable HTTP, stdio, versioning,
discovery, tools, caching, pagination, cancellation, progress,
subscriptions, authorization, authorization security considerations, and
the deprecated-features registry.

Six gaps. Two of them broke real clients without saying so.

## Decision

Fix all six, and record what was checked and found correct so the next
audit starts from a shorter list.

### Gaps found and closed

| #   | Gap                                                       | Why it mattered                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `io.modelcontextprotocol/clientCapabilities` not enforced | REQUIRED `_meta` field; a missing required field MUST be rejected `-32602` / HTTP 400. **Every modern test passed before this** because the test helper never sent the field either — the suite was pinning a shape the spec says to reject. |
| 2   | No `WWW-Authenticate`, no RFC 9728 metadata               | A server that authorizes over HTTP SHOULD conform to the authorization spec, which MUSTs Protected Resource Metadata. A conforming client had no way in and no way to tell "present a token" from "this endpoint is broken".                 |
| 3   | Unknown tool returned as `isError` content                | The spec puts unknown-tool on the protocol-error side. A model can retry a tool that rejected its arguments; it cannot conjure a tool that does not exist, so content-shaped failure invites an endless retry.                               |
| 4   | `tools/list` ignored unknown cursors                      | We issue no `nextCursor`, so any cursor came from elsewhere. Serving page one again loops a paging client forever.                                                                                                                           |
| 5   | The stdio shim sent no transport headers                  | On the HTTP hop the bridge **is** the Streamable HTTP client. Without `Mcp-Method` / `Mcp-Name` / `MCP-Protocol-Version`, **a modern-era stdio host was rejected `-32020`**. The bridge worked for legacy hosts only.                        |
| 6   | The stdio bridge could emit multi-line stdout             | Messages MUST NOT contain embedded newlines, and stdout MUST carry nothing but valid MCP messages. The bridge forwards bytes it does not produce; one pretty-printed or HTML body desynchronises the host's parser permanently.              |

### Checked and already conformant

Recorded so the next pass can skip them:

- **`server/discover`** — a MUST-implement; present, with `resultType`,
  `supportedVersions`, `capabilities`, `instructions`, caching hints and
  `_meta.serverInfo`.
- **Caching** — hints on both cacheable results, `ttlMs >= 0`, and
  `public` is correct for a compile-time tool list identical for every
  caller.
- **Cancellation** — the request context is cancelled on disconnect, so
  work stops; we emit no `notifications/cancelled` at all, which the
  spec restricts to subscription teardown.
- **Progress** — every requirement is MAY. A `progressToken` is ignored,
  which is explicitly allowed.
- **Origin validation**, the `-32020` / `-32022` codes and their `data`
  shapes, the reserved error-code ranges, and JSON Schema usage (valid
  2020-12, no network `$ref`, the recommended no-parameter form).
- **Authorization security considerations** — the two MUSTs that bind a
  resource server hold. We accept only tokens we minted (sha256 lookup
  in our own table), which is the strongest form of "verify they are the
  intended recipient"; and we never pass a caller's bearer upstream —
  LLM and embedding calls carry their own configured keys.

### Absent by choice, and not required

Unchanged from ADR 0007, re-verified against the spec text:

- `subscriptions/listen` — a SHOULD only for servers declaring
  `listChanged: true`. Ours is `false` and the tool list is frozen at
  compile time. A client that sends it gets `404` + `-32601`, which is
  what the spec requires for an unimplemented method.
- MRTR / `InputRequiredResult` — a MAY. No tool needs input mid-call.
- `x-mcp-header` — optional for servers; its MUSTs bind clients.
- `outputSchema` — explicitly optional. Absent on all 21 tools, tracked
  in #266 as a quality improvement, not a compliance one.
- OAuth 2.1 issuance. novamem is a resource server that mints its own
  bearers; it fronts no authorization server. The metadata document says
  so by omitting `authorization_servers` rather than naming one that
  cannot issue tokens for this resource.

## Consequences

- A client that omits `clientCapabilities` now gets a 400 where it
  previously got a result. That is the specified behaviour, and the only
  clients affected are ones sending a request this revision does not
  define.
- Modern-era stdio hosts work through the shim for the first time.
- Every guard added here is mutation-checked: the test fails when the
  guard is removed. For gap 1 the proof is historical rather than
  constructed — the whole modern suite passed without it.
- The next audit starts from "checked and already conformant" above.
  That list is only as good as its date: a new revision invalidates it,
  and this ADR should be superseded rather than edited.
