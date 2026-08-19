---
title: API tokens
---

# API tokens

Bearer tokens (`nm_…`) authorise data-plane calls — `POST /v1/search`, `POST /v1/remember`, etc. Every MCP host config that connects to novamem carries one of these. The dashboard cookie session is separate; it gates the dashboard itself + the per-user routes (`/v1/me/*`).

## Mint a token

API tokens page → **Mint token** → label. Project access is inherited from the owning user; pass `project` in requests when you want a sub-brain.

- **Label** — human-readable string. Use one per host so the per-token metrics chart is meaningful (e.g. `laptop · alice`, `ci-runner`, `agent-x`).

The plaintext token is shown ONCE. Copy it now or revoke + re-mint.

## What's stored

| Field                     | Storage                                        |
| ------------------------- | ---------------------------------------------- |
| Plaintext bearer (`nm_…`) | shown once, never persisted                    |
| SHA-256 hash              | `user_tokens.token_hash` — used for resolution |
| Label                     | `user_tokens.label`                            |
| Created-by user           | `user_tokens.user_id`                          |
| `last_used_at`            | bumped on every successful resolution          |
| `revoked_at`              | set on revoke; resolution then 401s            |

## Revoke

Click revoke on a row. The token's hash is marked revoked in the DB; the next resolution returns null and the request 401s. If the token had per-token metrics slots, those are cleared too.

Revocation is immediate — no cache TTL, no propagation delay.

## Lifecycle in practice

1. **Mint** when wiring a new host (the `novamem-init` CLI does this for you).
2. **Rotate** any time the token leaks — revoke + mint + reconfigure the host.
3. **Audit** via the per-token metrics chart on the dashboard — a token with steady traffic that suddenly spikes is worth investigating.
4. **Revoke** when retiring a host or when an employee leaves.

## API form

```bash
# Mint
curl -X POST https://novamem.example.com/v1/me/tokens \
  -H "Authorization: Bearer ns_..." \
  -d '{ "label": "ci-runner" }'

# List own tokens (hashes + labels, never plaintext)
curl https://novamem.example.com/v1/me/tokens \
  -H "Authorization: Bearer ns_..."

# Revoke
curl -X DELETE https://novamem.example.com/v1/me/tokens/<hash> \
  -H "Authorization: Bearer ns_..."
```

The `<hash>` is the SHA-256 hex listed by the GET — never the plaintext.

## See also

- [novamem-init CLI](../connect/init-cli.md) — automates mint + host wiring
- [Security model](../ops/security.md) — full auth model
