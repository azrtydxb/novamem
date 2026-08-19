#!/usr/bin/env python3
"""Compute the true relevant-set size per question, straight from Postgres.

`bench_retrieval.py` records `relevant_chunks` at ingest — the number of
chunks belonging to an evidence session. That is the correct denominator
for a remember-path corpus, which holds nothing else.

It is wrong for a capture-path corpus. Capture also stores extracted
facts, and a fact distilled from an evidence chunk is every bit as
relevant as the chunk itself. Scoring recall and nDCG against a
chunks-only ideal makes the capture arm look worse purely because it
retrieved facts the metric refused to count.

Emits `{question_id: n_relevant}` counting both, so the two arms are
scored against the same definition of "relevant".
"""

import argparse
import json
import subprocess


def psql(sql: str) -> list[list[str]]:
    out = subprocess.run(
        [
            "kubectl",
            "-n",
            "novamem-bench",
            "exec",
            "postgres-0",
            "--",
            "psql",
            "-U",
            "novamem",
            "-d",
            "novamem",
            "-t",
            "-A",
            "-F",
            "|",
            "-c",
            sql,
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    if out.returncode != 0:
        raise RuntimeError(out.stderr[:400])
    return [line.split("|") for line in out.stdout.strip().splitlines() if line.strip()]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ingest", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    state = json.load(open(args.ingest))["questions"]
    counts = {}
    for qid, meta in state.items():
        ns = meta["namespace"]
        answer_sids = set(meta["answer_session_ids"])
        id2session = meta.get("id2session") or {}

        # Chunk ids whose session is an evidence session. For the remember
        # path id2session is populated the same way, so this branch is
        # identical for both arms.
        relevant_chunk_ids = {
            cid for cid, sid in id2session.items() if sid in answer_sids
        }

        if not relevant_chunk_ids:
            # No id map (older runs): fall back to the recorded count.
            counts[qid] = meta.get("relevant_chunks", 0)
            continue

        ids_sql = ",".join("'%s'" % i.replace("'", "") for i in relevant_chunk_ids)
        rows = psql(
            "SELECT COUNT(*) FROM memory_entries "
            "WHERE namespace='%s' AND source_type='fact' "
            "AND metadata->>'source_chunk_id' IN (%s);" % (ns, ids_sql)
        )
        n_facts = int(rows[0][0]) if rows else 0
        counts[qid] = len(relevant_chunk_ids) + n_facts
        print(
            "  %-14s chunks=%3d facts_from_them=%3d  relevant=%3d"
            % (qid, len(relevant_chunk_ids), n_facts, counts[qid])
        )

    json.dump(counts, open(args.out, "w"), indent=2)
    print("wrote", args.out)


if __name__ == "__main__":
    main()
