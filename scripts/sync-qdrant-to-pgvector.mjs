#!/usr/bin/env node
/**
 * One-shot Qdrant → pgvector migration. Copies vectors as-is (no
 * re-embedding, no LLM), resolving each point's namespace/scope from its
 * warm row; Qdrant points whose warm row is gone are skipped as orphans.
 *
 * Fast-load pattern: per-partition HNSW indexes are DROPPED first, rows
 * stream in via batched multi-row INSERTs against bare heaps, and the
 * indexes are rebuilt once at the end under a large maintenance_work_mem.
 * Incremental HNSW insertion measured ~5k rows/min at 260k vectors; this
 * pattern loads the same data in a few minutes.
 *
 *   NOVAMEM_WARM_URL=postgres://... QDRANT_URL=http://qdrant:6333 \
 *     node sync-qdrant-to-pgvector.mjs [--partitions 32]
 *
 * Idempotent: ON CONFLICT DO NOTHING, and index rebuild uses IF NOT
 * EXISTS after a drop, so a crashed run can simply be re-run.
 */
import pg from "pg";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null))
    .filter(Boolean)
);
const PARTITIONS = Number(args.partitions ?? 32);
const QD = process.env.QDRANT_URL ?? "http://localhost:6333";
const pool = new pg.Pool({
  connectionString: process.env.NOVAMEM_WARM_URL,
  max: 4,
});

const t0 = Date.now();
console.log("dropping per-partition HNSW indexes for fast load...");
for (let i = 0; i < PARTITIONS; i++) {
  await pool.query(`DROP INDEX IF EXISTS idx_vectors_hnsw_p${i}`);
}

const cols = (
  await (await fetch(`${QD}/collections`)).json()
).result.collections.map((c) => c.name);
let copied = 0;
let orphans = 0;
for (const col of cols) {
  let offset = null;
  do {
    const body = {
      limit: 512,
      with_payload: true,
      with_vector: true,
      ...(offset ? { offset } : {}),
    };
    const r = await (
      await fetch(
        `${QD}/collections/${encodeURIComponent(col)}/points/scroll`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      )
    ).json();
    const pts = r.result.points;
    offset = r.result.next_page_offset;
    if (!pts.length) break;
    const ids = pts.map((p) => p.payload?.entryId).filter(Boolean);
    const { rows } = await pool.query(
      "SELECT id, user_id, project_id, namespace FROM memory_entries WHERE id = ANY($1)",
      [ids]
    );
    const meta = new Map(rows.map((x) => [x.id, x]));
    const values = [];
    const params = [];
    let n = 0;
    for (const p of pts) {
      const eid = p.payload?.entryId;
      const m = eid && meta.get(eid);
      if (!m) {
        orphans++;
        continue;
      }
      const scope =
        m.project_id === null ? `u:${m.user_id}` : `p:${m.project_id}`;
      values.push(
        `($${++n}, $${++n}, $${++n}, $${++n}, $${++n}, $${++n}::vector, $${++n})`
      );
      params.push(
        eid,
        m.user_id,
        m.project_id,
        m.namespace,
        scope,
        `[${p.vector.join(",")}]`,
        JSON.stringify(p.payload ?? {})
      );
      copied++;
    }
    if (values.length) {
      await pool.query(
        `INSERT INTO memory_vectors (entry_id, user_id, project_id, namespace, scope, embedding, payload)
         VALUES ${values.join(
           ","
         )} ON CONFLICT (entry_id, scope, namespace) DO NOTHING`,
        params
      );
    }
  } while (offset);
  console.log(`  ${col}: cumulative ${copied} copied, ${orphans} orphans`);
}

console.log(
  `rows loaded in ${Math.round(
    (Date.now() - t0) / 1000
  )}s; rebuilding HNSW indexes...`
);
// One dedicated session for the rebuild: SET is per-connection, and a
// pooled query may land on a different backend than the CREATE INDEX.
const idx = await pool.connect();
try {
  // 256MB, sequential: partitions are small by design, and a big value
  // here OOM-killed a 2Gi-limit pod during the bench migration.
  await idx.query("SET maintenance_work_mem = '256MB'");
  await idx.query("SET max_parallel_maintenance_workers = 0");
  for (let i = 0; i < PARTITIONS; i++) {
    const t = Date.now();
    await idx.query(
      `CREATE INDEX IF NOT EXISTS idx_vectors_hnsw_p${i} ON memory_vectors_p${i}
       USING hnsw (embedding vector_cosine_ops)`
    );
    console.log(
      `  index p${i} built in ${Math.round((Date.now() - t) / 1000)}s`
    );
  }
} finally {
  idx.release();
}
console.log(
  `DONE: ${copied} vectors, ${orphans} orphans, ${
    cols.length
  } collections, total ${Math.round((Date.now() - t0) / 1000)}s`
);
await pool.end();
