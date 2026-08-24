---
title: Backup & restore
---

# Backup & restore

novamem's source of truth is **Postgres** — including the `memory_relations` co-occurrence edges, which ride along with every Postgres backup. Only the cold-tier (Qdrant) lives outside it, and it is reconstructible from the warm-tier embeddings.

## What to back up

| Store        | Importance | Recovery                                                                                                        |
| ------------ | ---------- | --------------------------------------------------------------------------------------------------------------- |
| **Postgres** | Critical   | Required for any restore. Holds memory_entries, memory_relations, users, sessions, tokens, projects, audit log. |
| **Qdrant**   | Optional   | Re-index from warm-tier entries via `/v1/admin/reindex` (planned). Until then, snapshot and restore.            |

In practice, back up both. Postgres restoration without Qdrant works (search degrades to keyword-only with `degraded: true`) but you want both for full fidelity.

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

Snapshot every collection (one per user/project scope × namespace). If your tenant count is large, automate via the [Qdrant snapshot API](https://qdrant.tech/documentation/concepts/snapshots/).

## Relations (memory_relations)

Nothing extra to do: the co-occurrence edges live in the `memory_relations` Postgres table (bitemporal `valid_from`/`valid_to`), so `pg_dump` / WAL archiving above covers them. Edges are also self-healing — new `remember` calls write fresh vector-neighbour edges via the async reconciler.

## Disaster scenarios

| Scenario                  | Recovery procedure                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Postgres lost (no backup) | Total memory loss — entries and relations alike. Don't run without a backup strategy.                                   |
| Postgres corrupt          | Restore latest dump → restart novamem → cold-tier still has older vectors but new writes are coherent.                  |
| Qdrant lost               | Restart with empty Qdrant → `/v1/admin/reindex` (planned) re-embeds every warm entry from `content`. Slow but lossless. |
| Whole cluster lost        | Restore Postgres dump → Qdrant snapshots → start novamem. Verify with `GET /health`.                                    |

## Operational tip

Time-bound your backup tests. A backup that hasn't been restored is hypothetical. Schedule a quarterly drill: restore yesterday's dump into a sandbox cluster, run `/health`, run a few `memory_search` calls, confirm signal scores match expectations.
