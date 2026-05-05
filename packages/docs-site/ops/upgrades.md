---
title: Upgrades
---

# Upgrades

novamem's `/v1/*` API is stable — no breaking changes within a major release. Schema migrations are forward-only.

## Tag conventions

| Tag | Meaning |
|---|---|
| `vX.Y.Z` | Server release. The repo's GitHub release. Image at `ghcr.io/azrtydxb/novamem:sha-<...>`. |
| `@azrtydxb/novamem-mcp@X.Y.Z` | Stdio shim release. Pin in your MCP host config. |
| `@azrtydxb/novamem-init@X.Y.Z` | CLI release. `npx -y` always pulls latest. |
| `:main` | Always current. Useful for staging; pin a sha for production. |
| `:sha-<7chars>` | Deterministic. Reproducible deploys. |

## Reading release notes

Every server release has notes on [GitHub Releases](https://github.com/azrtydxb/novamem/releases). Look for:

- **Breaking changes** — surface as a clearly-labelled section. Pre-1.0 there shouldn't be any to `/v1/*`; if there are, they'll be called out.
- **Migration steps** — prepended with `→` and listed before the changelog.
- **Image** — the `ghcr.io` tag for that release.

## Standard upgrade

### Docker Compose

```bash
# 1. Backup
PGPASSWORD=$POSTGRES_PASSWORD pg_dump -h localhost -U novamem novamem \
  --format=custom > novamem-pre-upgrade.dump

# 2. Update the tag
sed -i 's|novamem:.*|novamem:sha-<NEW>|' docker-compose.yaml

# 3. Pull + restart
docker compose pull novamem
docker compose up -d novamem

# 4. Verify
docker compose logs -f novamem | head -30
curl http://localhost:7778/health
```

### Kubernetes

```bash
kubectl -n novamem set image deployment/novamem novamem=ghcr.io/azrtydxb/novamem:sha-<NEW>
kubectl -n novamem rollout status deployment/novamem --timeout=300s
```

novamem runs migrations on boot via `drizzle-kit`. The first pod of the new replica set runs them; the others wait. Migrations are idempotent — a half-finished rollout is recoverable.

## Schema migrations

Forward-only. The migrator (`packages/server/src/warm-store/migrate.ts`) tracks state in `__drizzle_migrations`. Steps are SQL files in `packages/server/src/warm-store/migrations/`.

If a migration fails:

1. The pod fails liveness, k8s rolls back to the previous replica set.
2. Inspect logs: `kubectl logs deployment/novamem`.
3. Repair the data (or open an issue), then re-deploy.
4. Manual recovery: connect to Postgres, fix `__drizzle_migrations` if the partial migration left an invalid state, re-deploy.

## Embedder model upgrades

Changing `NOVAMEM_EMBEDDINGS_MODEL` (or moving from `local-transformers` to `openai-compatible`) means the cold-tier vectors no longer match what new queries embed. The vector tier degrades silently.

To migrate:

1. Set the new model.
2. Run a re-embed (`/v1/admin/reindex`, planned). Until that endpoint exists, the safest path is to forget + remember a representative subset, or accept a degraded vector tier until decay rolls old entries off naturally.
3. `NOVAMEM_COLD_VECTOR_SIZE` must match the new model. Mismatched dim → Qdrant rejects writes.

## Rollback

```bash
# Compose
sed -i 's|novamem:.*|novamem:sha-<OLD>|' docker-compose.yaml
docker compose up -d novamem

# k8s
kubectl -n novamem rollout undo deployment/novamem
```

Schema migrations are forward-only — rollback at the **server image** layer is safe, but if the new release ran a migration, the old server may not be able to read the new schema. Test in staging before rolling forward to prod.

## Pin in your MCP hosts

After upgrading the server, you might need to update the stdio shim version in client configs. The `novamem-init --shim-version` flag does this in bulk; or hand-edit each host's config.

The shim's protocol is simple — old shims work against new servers in practice. Major version bumps that affect the shim/server contract will be called out in release notes.
