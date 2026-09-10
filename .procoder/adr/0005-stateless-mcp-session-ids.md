# 0005 — Streamable MCP session ids are stateless and self-authenticating

Status: accepted
Date: 2026-09-10

## Context

`go/internal/mcp` keeps MCP sessions in a per-process map (`registry`).
A client's `initialize` creates the session on whichever replica served
it; every follow-up POST carries `Mcp-Session-Id` and is load-balanced
independently, so it usually reaches a replica that has never seen the
id and gets `404 {"error":"unknown sessionId"}`.

Measured on the kw deployment (3 replicas, round-robin ingress): 4 of 9,
then 8 of 20 reused-session calls succeeded — the ~1/N rate a per-pod
map predicts. Claude Code surfaced this as
`Failed to connect — HTTP 404: unknown sessionId`, which reads as a
client fault rather than a scaling fault. `deploy/k8s/novamem.yaml`
ships `replicas: 1`, so the default is safe, but the server cannot be
scaled out at all without per-client ingress affinity.

The enabling observation: for the streamable transport a session holds
**no server state**. `handleMessage` reads exactly one field, `sess.userID`
(`server.go`), and that value is re-derived from the caller's bearer on
every single request by the auth middleware. The map entry exists only
for liveness (idle reaping) and the per-user session cap. Nothing about
answering a request needs the replica that minted the id.

The SSE transport is different: `POST /mcp/messages` must queue a frame
onto the goroutine holding that session's open `GET` stream, which is
inherently pod-local. SSE cannot be made replica-agnostic this way.

## Decision

Streamable session ids become stateless and self-authenticating:

    id = base64url(nonce16 || issuedAtMs8) "." base64url(tag16)
    tag = HMAC-SHA256(key, nonce16 || issuedAtMs8 || userID)[:16]
    key = HMAC-SHA256(NOVAMEM_COOKIE_SECRET, "novamem/mcp-session-id/v1")

Any replica can verify an id it has never seen: recompute the tag from
the _caller's own_ authenticated `userID`. If it matches and the id is
within `sessionIDMaxAge` (24h), the replica adopts the session into its
local registry (subject to the same per-user cap) and serves the request.
If it does not match, the answer is the existing 404.

The id is bound to the user by construction, so it cannot be replayed as
anyone else. The ownership check on a locally-known session (403 for a
non-owner) is unchanged — adoption applies only to ids this replica does
not know.

`NOVAMEM_COOKIE_SECRET` is the key root because it is already present and
identical on every replica. It is never used directly: the label-derived
subkey gives domain separation from cookie signing, so an MCP session id
can never be confused with, or used to forge, a session cookie.

SSE keeps unguessable random ids and per-pod semantics, and still needs
affinity to scale out. Rejected alternatives: a shared session table in
Postgres (a write per request, and per-request durable state for
something that carries no state); adopting _any_ well-formed unknown id
(see the DoS in the review below); and documenting ingress affinity as
the permanent answer (leaves a scaling trap whose failure mode is
misattributed to the client).

## Security review

Required before accepting this, because session ids become caller-assertable.

- **Privilege.** Unchanged. Every request is authorized by its bearer;
  `userID` is never read from the session. An adopted session is bound to
  the caller's own identity, so asserting an id cannot widen access.
- **Forgery.** Minting an id for another user requires the derived key.
  Without it, the tag cannot be produced; verification uses `hmac.Equal`
  (constant time).
- **Cross-user DoS — the reason for signing.** Naive adoption ("trust any
  unknown id") lets an attacker who learns victim A's id assert it on a
  replica that lacks it; the replica would bind that id to the attacker,
  and A's next request there would 403. Signing removes this: the
  attacker's caller identity does not match the tag, so the id is
  rejected and never adopted.
- **Replay / lifetime.** `issuedAtMs` is inside the signed payload, so an
  id stops being adoptable after `sessionIDMaxAge`. An id is not a
  credential on its own — it is useless without a valid bearer for the
  same user — so its lifetime is a defence-in-depth bound, not the
  primary control. Revoking the token revokes the access.
- **Teardown is local, by design.** `DELETE /mcp` drops the session on the
  replica that serves the DELETE; the signed id stays adoptable elsewhere
  until it ages out. This is cosmetic rather than a privilege issue, for
  the same reason: access requires the bearer.
- **Malformed input is rejected on length alone**, before any base64
  decoding, so an `Mcp-Session-Id` header (bounded only by
  `MaxHeaderBytes`) cannot be decoded into a large allocation just to be
  thrown away. Verified by an allocation assertion, not just by the
  rejection.
- **Per-user cap is per-replica.** A client legitimately holding one
  adopted session per replica consumes one slot on each, so the effective
  ceiling is `cap × replicas`. The cap guards one process's map against
  unbounded growth, and still does.
- **No secret configured** (`auth_mode=none`, no `NOVAMEM_COOKIE_SECRET`):
  ids fall back to unverifiable random values and adoption is disabled —
  exactly today's behaviour. The server logs this at startup so the
  scaling limitation is visible rather than latent.

## Consequences

- The streamable transport, which is what current MCP clients use, works
  behind a plain round-robin load balancer at any replica count.
- The kw `novamem-mcp` Service and its `upstream-hash-by` ingress remain
  useful only for SSE clients; the streamable path no longer depends on
  them.
- `NOVAMEM_COOKIE_SECRET` gains a second consumer. Rotating it
  invalidates live MCP session ids (clients re-`initialize`) in addition
  to session cookies.
- Session ids grow from a 36-char UUID to 55 chars.
- The per-user cap is now enforced atomically (count and insert under one
  lock) on all three session-creating paths, including SSE. Previously
  concurrent requests could each observe `count < max` and all insert.
