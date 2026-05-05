---
title: Backup & restore
---

# Backup & restore

novamem's source of truth is **Postgres**. The cold-tier (Qdrant) and graph-tier (FalkorDB) are reconstructible from the warm-tier embeddings and edge auto-link logic.

## What to back up

| Store | Importance | Recovery |
|---|---|---|
| **Postgres** | Critical | Required for any restore. Holds memory_entries, users, sessions, tokens, projects, audit log. |
| **Qdrant** | Optional | Re-index from warm-tier entries via `/v1/admin/reindex` (planned). Until then, snapshot and restore. |
| **FalkorDB** | Optional | Re-link from warm-tier on next dream cycle. Edges with `kind = "vector_neighbour"` will reform; manually-added edges (`kind = "co_occurs"`) are lost without a backup. |

In practice, back up all three. Postgres restoration without Qdrant + FalkorDB works (search degrades to keyword + vector with `degraded: true` for graph) but you want all three for full fidelity.

## Postgres

### `pg_dump` for full daily snapshots

```bash
PGPASSWORD=$POSTGRES_PASSWORD pg_dump \
  -h postgres -U novamem -d novamem \
  --format=custom --compress=9 \
  --file novamem-$(date +%F).dump
```

Restore:

```bash
PGPASSWORD=$POSTGRES_PASSWORD pg_restore \
  -h postgres -U novamem -d novamem --clean --if-exists \
  novamem-2026-05-05.dump
```

### WAL archive for point-in-time recovery

If you need PITR (e.g. recover from accidental delete to 5 minutes before), enable continuous archiving:

```ini
# postgresql.conf
wal_level = replica
archive_mode = on
archive_command = 'aws s3 cp %p s3://my-bucket/wal/%f'
```

Combine with a base backup via `pg_basebackup` and you can restore to any LSN.

## Qdrant

```bash
# Snapshot a collection
curl -X POST http://qdrant:6333/collections/novamem_acme_default/snapshots

# Download
curl http://qdrant:6333/collections/novamem_acme_default/snapshots/<name> > snap.tgz

# Restore
curl -X PUT http://qdrant:6333/collections/novamem_acme_default/snapshots/upload \
  -F snapshot=@snap.tgz
```

Snapshot every collection (one per `tenant × project × namespace`). If your tenant count is large, automate via the [Qdrant snapshot API](https://qdrant.tech/documentation/concepts/snapshots/).

## FalkorDB / Redis

Standard Redis persistence:

- **AOF** (append-only file) — `appendonly yes` in `redis.conf`. Replay-based recovery, lower data-loss risk.
- **RDB** (point-in-time dump) — `save 900 1` style. Smaller files, larger possible data loss.

Both can be combined. Restore by replacing `dump.rdb` / `appendonly.aof` and restarting.

## Disaster scenarios

| Scenario | Recovery procedure |
|---|---|
| Postgres lost (no backup) | Total memory loss. Don't run without a backup strategy. |
| Postgres corrupt | Restore latest dump → restart novamem → cold-tier still has older vectors but new writes are coherent. |
| Qdrant lost | Restart with empty Qdrant → `/v1/admin/reindex` (planned) re-embeds every warm entry from `content`. Slow but lossless. |
| FalkorDB lost | Restart empty → next remember rebuilds edges via `linkVectorNeighbors`. Older entries lose graph-tier hits until they get re-linked. |
| Whole cluster lost | Restore Postgres dump → Qdrant snapshots → FalkorDB AOF → start novamem. Verify with `GET /health`. |

## Operational tip

Time-bound your backup tests. A backup that hasn't been restored is hypothetical. Schedule a quarterly drill: restore yesterday's dump into a sandbox cluster, run `/health`, run a few `memory_search` calls, confirm signal scores match expectations.
