#!/usr/bin/env python3
"""Retrieval-only LongMemEval harness for NovaMem (nova-bench).

Separates the two things the existing runner conflates:
  * ingest once  (expensive: embeddings + pg + qdrant)
  * score many   (cheap: /v1/search only, no LLM at all)

Ground truth = LongMemEval `answer_session_ids`. A retrieved chunk is
relevant iff its `session=` marker is one of them. That gives recall /
MRR / nDCG with zero LLM involvement, so a config sweep is fast,
deterministic and free of answerer noise.

Modes:
  ingest   seed a stratified subset into per-question namespaces
  search   run one named config over the seeded corpus, score it
  purge    delete the seeded namespaces
"""
import argparse
import json
import math
import os
import re
import sys
import threading
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib import request, error

import ijson

# ~4 chars/token, so 24k chars is comfortably under an 8192-token window
# even when a chunk tokenises worse than average.
MAX_CHUNK_CHARS = 24_000

_PRINT_LOCK = threading.Lock()


def log(msg):
    with _PRINT_LOCK:
        print(msg, flush=True)


def http_json(method, url, token, payload=None, timeout=180, attempts=4):
    headers = {"accept": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    data = None
    if payload is not None:
        headers["content-type"] = "application/json"
        data = json.dumps(payload).encode()
    last = None
    for attempt in range(1, attempts + 1):
        req = request.Request(url, data=data, headers=headers, method=method)
        try:
            with request.urlopen(req, timeout=timeout) as r:
                body = r.read().decode()
                return json.loads(body) if body else None
        except error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:400]
            last = RuntimeError(f"{method} {url} HTTP {e.code}: {detail}")
            if e.code not in {429, 500, 502, 503, 504} or attempt >= attempts:
                raise last
        except Exception as e:
            last = RuntimeError(f"{method} {url}: {e}")
            if attempt >= attempts:
                raise last
        time.sleep(min(2 ** (attempt - 1), 8))
    raise last


# ── dataset ────────────────────────────────────────────────────────────

def load_subset(dataset, n, skip=0):
    """Stratified pick of n questions across the six LongMemEval types.

    `skip` drops the first `skip` picks *after* stratification, so a
    validation set drawn with skip=N is disjoint from the tuning set of
    size N while keeping the same type balance.
    """
    buckets = defaultdict(list)
    with open(dataset, "rb") as f:
        for idx, item in enumerate(ijson.items(f, "item")):
            buckets[item.get("question_type")].append((idx, item))
    types = sorted(buckets)
    picked = []
    i = 0
    while len(picked) < n + skip:
        progressed = False
        for t in types:
            if i < len(buckets[t]) and len(picked) < n + skip:
                picked.append(buckets[t][i])
                progressed = True
        if not progressed:
            break
        i += 1
    return sorted(picked[skip:], key=lambda p: p[0])


def chunks_for_session(qid, sid, date, turns, run_id, turns_per_chunk=2):
    """`run=` in the header is load-bearing, not decoration.

    NovaMem dedups on (user_id, project_id, content_hash) — namespace is
    NOT in that key, and `force: true` only skips the worthiness gate, not
    the content-hash fast path. Without a per-run discriminator, chunks
    identical to a previous run's collapse onto those older entries and
    nothing lands in this run's namespace.
    """
    clean = [t for t in turns if (t.get("content") or "").strip()]
    for i in range(0, len(clean), turns_per_chunk):
        part = clean[i:i + turns_per_chunk]
        lines = [
            f"[LongMemEval run={run_id} question={qid} session={sid} chunk={i // turns_per_chunk}]",
            f"Session: {sid}",
            f"Date: {date}",
        ]
        for t in part:
            lines.append(f"{t.get('role', 'speaker')}: {(t.get('content') or '').strip()}")
        body = "\n".join(lines)
        # Turn-pairs are not a size bound. One assistant turn in this
        # dataset runs to 78k characters (~19.5k tokens), which bge-m3
        # rejects outright at its 8192-token window — and NovaMem then
        # parks the entry unembedded forever. Cap on characters so a
        # verbose turn produces several chunks instead of one unusable
        # one. MAX_CHUNK_CHARS leaves headroom under 8192 tokens.
        if len(body) <= MAX_CHUNK_CHARS:
            yield body
            continue
        head = "\n".join(lines[:3])
        rest = "\n".join(lines[3:])
        budget = MAX_CHUNK_CHARS - len(head) - 1
        for part_no, start in enumerate(range(0, len(rest), budget)):
            yield f"{head}\n{rest[start:start + budget]}" if part_no == 0 else \
                  f"{head} part={part_no}\n{rest[start:start + budget]}"


# ── metrics ────────────────────────────────────────────────────────────

def score_ranking(rel_flags, n_relevant_chunks, cutoffs):
    """rel_flags: list of bool, rank-ordered.

    `n_relevant_chunks` is the number of chunks in the namespace that come
    from an evidence session — the true denominator for recall, and the
    ideal-DCG length. Using the count of answer *sessions* here (as an
    earlier draft did) understates the ideal and pushes nDCG above 1.
    """
    out = {}
    total_rel = max(1, n_relevant_chunks)
    for k in cutoffs:
        top = rel_flags[:k]
        hits = sum(top)
        first = next((i + 1 for i, r in enumerate(top) if r), None)
        dcg = sum(1.0 / math.log2(i + 2) for i, r in enumerate(top) if r)
        idcg = sum(1.0 / math.log2(i + 2) for i in range(min(k, total_rel)))
        out[f"top_{k}"] = {
            "any_hit": 1 if hits else 0,
            "hits": hits,
            "recall": hits / total_rel,
            "precision": hits / k if k else 0.0,
            "mrr": (1.0 / first) if first else 0.0,
            "ndcg": (dcg / idcg) if idcg else 0.0,
            "first_rank": first,
        }
    return out


def aggregate(per_q, cutoffs):
    types = sorted({q["question_type"] for q in per_q})
    by_cutoff = {}
    for k in cutoffs:
        key = f"top_{k}"
        rows = [q["metrics"][key] for q in per_q if key in q["metrics"]]
        def mean(field):
            return (sum(r[field] for r in rows) / len(rows)) if rows else 0.0
        by_type = {}
        for t in types:
            trows = [q["metrics"][key] for q in per_q if q["question_type"] == t and key in q["metrics"]]
            by_type[t] = {
                "n": len(trows),
                "any_hit_rate": (sum(r["any_hit"] for r in trows) / len(trows) * 100) if trows else 0.0,
                "ndcg": (sum(r["ndcg"] for r in trows) / len(trows)) if trows else 0.0,
            }
        by_cutoff[key] = {
            "overall": {
                "n": len(rows),
                "any_hit_rate": mean("any_hit") * 100,
                "mrr": mean("mrr"),
                "ndcg": mean("ndcg"),
                "recall": mean("recall"),
                "precision": mean("precision"),
                "avg_hits": mean("hits"),
            },
            "by_question_type": by_type,
        }
    return by_cutoff


# ── modes ──────────────────────────────────────────────────────────────

def ns_for(run_id, qid):
    return f"nb-{run_id}-{qid}"[:120]


def do_ingest(args, token, items, out_dir):
    state_path = out_dir / "ingest.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {"questions": {}}

    def one(entry):
        idx, item = entry
        qid = str(item["question_id"])
        if state["questions"].get(qid, {}).get("ingested"):
            prev = state["questions"][qid]
            return qid, prev["chunks"], prev.get("relevant_chunks", 0), prev.get("id2session", {}), 0.0
        ns = ns_for(args.run_id, qid)
        answer_sids = set(item.get("answer_session_ids") or [])
        t0 = time.time()
        n = 0
        n_rel = 0
        n_dedup = 0
        id2session = {}
        for sid, date, sess in zip(item.get("haystack_session_ids") or [],
                                   item.get("haystack_dates") or [],
                                   item.get("haystack_sessions") or []):
            for content in chunks_for_session(qid, sid, date, sess, args.run_id):
                if sid in answer_sids:
                    n_rel += 1
                endpoint = "/v1/capture" if args.write_path == "capture" else "/v1/remember"
                resp = http_json("POST", args.base_url.rstrip("/") + endpoint, token, {
                    "content": content,
                    "namespace": ns,
                    "force": True,
                    "sourceType": "benchmark",
                    "source": "novamem-retrieval-harness",
                    "sensitivity": "internal",
                    "metadata": {"benchmark": "longmemeval", "question_id": qid, "session_id": sid},
                }, timeout=180)
                n += 1
                # Extracted facts carry `source_chunk_id`, not the
                # `session=` marker, so relevance for a fact has to be
                # resolved through the chunk it came from.
                if (resp or {}).get("id"):
                    id2session[str(resp["id"])] = sid
                if (resp or {}).get("deduplicated"):
                    n_dedup += 1
        # A dedup hit means this chunk collapsed onto a pre-existing entry
        # in some other namespace, so it is NOT in `ns` and the namespace
        # is silently under-populated. Fail loudly rather than score a
        # corpus that isn't there.
        if n_dedup and args.write_path == "remember":
            raise RuntimeError(
                f"{qid}: {n_dedup}/{n} chunks deduplicated onto pre-existing entries — "
                f"corpus is not isolated in {ns}; vary --run-id or purge prior runs")
        return qid, n, n_rel, id2session, time.time() - t0

    started = time.time()
    done = 0
    failures = 0
    with ThreadPoolExecutor(max_workers=args.max_workers) as pool:
        futs = {pool.submit(one, e): e for e in items}
        for fut in as_completed(futs):
            idx, item = futs[fut]
            qid = str(item["question_id"])
            try:
                qid, n, n_rel, id2session, secs = fut.result()
                state["questions"][qid] = {
                    "ingested": True, "chunks": n, "relevant_chunks": n_rel,
                    "id2session": id2session, "write_path": args.write_path,
                    "namespace": ns_for(args.run_id, qid),
                    "dataset_index": idx, "question_type": item.get("question_type"),
                    "question": item.get("question"), "question_date": item.get("question_date"),
                    "answer": item.get("answer"),
                    "answer_session_ids": list(item.get("answer_session_ids") or []),
                }
                done += 1
                state_path.write_text(json.dumps(state, indent=2))
                log(f"[{done}/{len(items)}] ingested {qid} chunks={n} in {secs:.0f}s "
                    f"(elapsed {(time.time()-started)/60:.1f}m)")
            except Exception as e:
                failures += 1
                log(f"ERROR ingest {qid}: {e}")
    state_path.write_text(json.dumps(state, indent=2))
    log(f"ingest complete: {done} questions, {(time.time()-started)/60:.1f} min")
    if failures:
        # State is written (resume covers the gap), but a partial corpus
        # must not look like a successful run to callers like quick-gate.
        raise SystemExit(f"ingest finished with {failures} failed questions — "
                         f"re-run to resume; state saved")


def do_search(args, token, out_dir):
    state = json.loads((out_dir / "ingest.json").read_text())
    cutoffs = sorted({int(x) for x in args.cutoffs.split(",") if x.strip()})
    kmax = max(cutoffs)
    cfg = json.loads(args.config) if args.config else {}
    rel_override = json.loads(Path(args.relevant_counts).read_text()) if args.relevant_counts else {}
    per_q = []
    search_failures = 0
    lat = []

    def one(qid, meta):
        payload = {
            "query": meta["question"],
            "k": kmax,
            "namespace": meta["namespace"],
            "maxSensitivity": "sensitive",
        }
        payload.update(cfg)
        t0 = time.time()
        obj = http_json("POST", args.base_url.rstrip("/") + "/v1/search", token, payload, timeout=240)
        ms = (time.time() - t0) * 1000
        rows = (obj or {}).get("results") or []
        answer_sids = set(meta["answer_session_ids"])
        flags = []
        ranked = []
        id2session = meta.get("id2session") or {}
        for r in rows:
            c = r.get("content") or ""
            m = re.search(r"session=([^\s\]]+)", c)
            sid = m.group(1) if m else None
            if sid is None:
                # An extracted fact has no session marker of its own — it
                # inherits the provenance of the chunk it was distilled
                # from. Without this every fact scores as irrelevant and
                # the capture path looks strictly worse than it is.
                src = (r.get("metadata") or {}).get("source_chunk_id")
                if src:
                    sid = id2session.get(str(src))
            rel = sid in answer_sids
            flags.append(rel)
            row = {"sid": sid, "rel": rel, "score": r.get("score")}
            # Content is only kept when an answerer stage will need it —
            # it is ~2KB per chunk and would otherwise bloat every arm of
            # the sweep for no reason.
            if len(ranked) < args.store_content:
                row["content"] = c
            ranked.append(row)
        return {
            "question_id": qid,
            "question_type": meta["question_type"],
            "n_returned": len(rows),
            "n_answer_sessions": len(answer_sids),
            "n_relevant_chunks": rel_override.get(qid, meta.get("relevant_chunks", 0)),
            "metrics": score_ranking(flags, rel_override.get(qid, meta.get("relevant_chunks", 0)), cutoffs),
            "latency_ms": ms,
            "top_ranked": ranked[:max(20, args.store_content)],
            "degraded": (obj or {}).get("degraded"),
        }, ms

    qs = [(q, m) for q, m in state["questions"].items() if m.get("ingested")]
    with ThreadPoolExecutor(max_workers=args.max_workers) as pool:
        futs = {pool.submit(one, q, m): q for q, m in qs}
        for fut in as_completed(futs):
            try:
                res, ms = fut.result()
                per_q.append(res)
                lat.append(ms)
            except Exception as e:
                search_failures += 1
                log(f"ERROR search {futs[fut]}: {e}")

    lat.sort()
    report = {
        "config_name": args.name,
        "search_config": cfg,
        "base_url": args.base_url,
        "n_questions": len(per_q),
        "cutoffs": cutoffs,
        "latency_ms": {
            "mean": sum(lat) / len(lat) if lat else 0,
            "p50": lat[len(lat) // 2] if lat else 0,
            "p95": lat[int(0.95 * len(lat))] if lat else 0,
            "max": lat[-1] if lat else 0,
        },
        "metrics_by_cutoff": aggregate(per_q, cutoffs),
        "per_question": sorted(per_q, key=lambda q: q["question_id"]),
    }
    path = out_dir / f"search-{args.name}.json"
    path.write_text(json.dumps(report, indent=2))
    log(json.dumps({"config": args.name, "latency_p95_ms": report["latency_ms"]["p95"],
                    "metrics": {k: v["overall"] for k, v in report["metrics_by_cutoff"].items()}}, indent=2))
    log(f"wrote {path}")
    if search_failures:
        raise SystemExit(f"search finished with {search_failures} failed questions — "
                         f"report written but the run is INVALID for verdicts")



def do_purge(args, token, out_dir):
    state = json.loads((out_dir / "ingest.json").read_text())
    # No bulk namespace delete exists; use /v1/forget per id via /v1/recent paging.
    total = 0
    for qid, meta in state["questions"].items():
        ns = meta["namespace"]
        while True:
            obj = http_json("GET", args.base_url.rstrip("/") +
                            f"/v1/recent?namespace={ns}&limit=200", token, timeout=120)
            rows = (obj or {}).get("results") or obj or []
            if not rows:
                break
            for r in rows:
                try:
                    http_json("POST", args.base_url.rstrip("/") + "/v1/forget", token,
                              {"id": str(r["id"])}, timeout=60)
                    total += 1
                except Exception:
                    pass
        log(f"purged {ns} (running total {total})")
    log(f"purge complete: {total} entries")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["ingest", "search", "purge"])
    ap.add_argument("--dataset")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--base-url", default="http://192.168.10.121:7778")
    ap.add_argument("--token-file", required=True)
    ap.add_argument("--run-id", default="r1")
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--write-path", choices=["remember", "capture"], default="remember",
                    help="capture exercises fact extraction + semantic dedupe/supersession — "
                         "NovaMem's real agent-facing write path")
    ap.add_argument("--skip", type=int, default=0,
                    help="Drop the first N stratified picks — use to draw a held-out set")
    ap.add_argument("--max-workers", type=int, default=6)
    ap.add_argument("--cutoffs", default="5,10,20,50,200")
    ap.add_argument("--name", default="baseline")
    ap.add_argument("--config", help="JSON merged into the /v1/search body")
    ap.add_argument("--relevant-counts",
                    help="JSON {question_id: n_relevant} overriding the ingest-time chunk count. "
                         "Required for capture-path corpora, where extracted facts are also relevant.")
    ap.add_argument("--store-content", type=int, default=0,
                    help="Keep verbatim content for the top-N results (needed by answer_eval.py)")
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    token = Path(args.token_file).read_text().strip()

    if args.mode == "ingest":
        items = load_subset(args.dataset, args.limit, args.skip)
        log(f"selected {len(items)} questions: " +
            json.dumps(Counter(i[1].get('question_type') for i in items)))
        do_ingest(args, token, items, out_dir)
    elif args.mode == "search":
        do_search(args, token, out_dir)
    else:
        do_purge(args, token, out_dir)


if __name__ == "__main__":
    main()
