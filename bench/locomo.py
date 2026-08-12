#!/usr/bin/env python3
"""LoCoMo-10 adapter — the fast full-pipeline benchmark (plan: benchmark
ladder rung 2). Exercises ingest (capture path), drain, search, and
answer accuracy end-to-end against a NovaMem server, small enough to
iterate on write-path changes without the LongMemEval wait.

Default is SHORT mode: 2 conversations, 50 sampled questions — roughly a
10-minute cycle. `--convs 10 --questions 0` runs the whole thing.

Categories (dataset labels): 1 multi-hop, 2 temporal, 3 open-domain,
4 single-hop, 5 adversarial/unanswerable.
"""
import argparse, collections, json, pathlib, random, re, sys, time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from answer_eval import chat, answer_prompt, judge_prompt, parse_judge

DATASET_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"


def http(base, token, path, body, timeout=60, attempts=4):
    last = None
    for a in range(attempts):
        req = urllib.request.Request(base + path, data=json.dumps(body).encode(),
                                     headers={"Authorization": f"Bearer {token}",
                                              "content-type": "application/json"})
        try:
            return json.loads(urllib.request.urlopen(req, timeout=timeout).read())
        except urllib.error.HTTPError as e:
            # Retry server-side blips (a proxy rebalancing, a pod mid-roll);
            # client errors are real and re-raise immediately.
            if e.code < 500:
                raise
            last = e
        except Exception as e:
            last = e
        time.sleep(min(2 ** a, 8))
    raise last


def pair_chunks(conv, run_id, ci):
    """Session turns → 2-turn chunks with the session date header, the
    same shape the LongMemEval harness ingests."""
    out = []
    si = 1
    while f"session_{si}" in conv:
        date = conv.get(f"session_{si}_date_time", "")
        turns = conv[f"session_{si}"]
        for i in range(0, len(turns), 2):
            block = turns[i:i + 2]
            text = "\n".join(f"{t['speaker']}: {t['text']}" for t in block)
            out.append(f"[LoCoMo run={run_id} conv={ci} session={si} chunk={i//2}]\n"
                       f"Date: {date}\n{text}")
        si += 1
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://192.168.10.121:7778")
    ap.add_argument("--token-file", required=True)
    ap.add_argument("--key-file", required=True)
    ap.add_argument("--llm-base", default="http://192.168.10.125/v1")
    ap.add_argument("--model", default="qwen3-6-35b-a3b-nvfp4")
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--convs", type=int, default=2)
    ap.add_argument("--questions", type=int, default=50,
                    help="questions sampled across the ingested convs; 0 = all")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--max-workers", type=int, default=6)
    ap.add_argument("--thinking", action="store_true")
    ap.add_argument("--search-config", default='{"weights":{"keyword":0,"vector":1,"graph":0,"recency":0,"entity":0},"maxTokens":6000,"k":20,"rerank":true}')
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    token = pathlib.Path(args.token_file).read_text().strip()
    key = pathlib.Path(args.key_file).read_text().strip()
    ds_path = pathlib.Path(__file__).parent / "locomo10.json"
    if not ds_path.exists():
        urllib.request.urlretrieve(DATASET_URL, ds_path)
    data = json.loads(ds_path.read_text())[: args.convs]
    t0 = time.time()

    # ── ingest (capture path; per-conversation namespace) ──────────────
    n_chunks = 0
    for ci, conv in enumerate(data):
        ns = f"lc-{args.run_id}-{ci}"
        chunks = pair_chunks(conv["conversation"], args.run_id, ci)
        n_chunks += len(chunks)
        with ThreadPoolExecutor(max_workers=args.max_workers) as ex:
            list(ex.map(lambda c: http(args.base_url, token, "/v1/capture",
                                       {"content": c, "namespace": ns, "force": True}), chunks))
    t_ingest = time.time() - t0
    print(f"ingested {n_chunks} chunks from {len(data)} convs in {t_ingest:.0f}s", flush=True)

    # ── drain wait (facts queue) ────────────────────────────────────────
    t1 = time.time()
    zero = 0
    while zero < 2:
        req = urllib.request.Request(args.base_url + "/health")
        try:
            st = json.loads(urllib.request.urlopen(req, timeout=20).read())
            pend = st.get("pendingEmbeddings")
        except Exception:
            pend = 1
        # pendingEmbeddings covers the vector debt; the facts queue drains
        # on the same reconciler cadence, so two stable-zero reads plus
        # one extra tick is a sound settle signal for a corpus this size.
        zero = zero + 1 if not pend else 0
        time.sleep(15)
    time.sleep(30)
    t_drain = time.time() - t1
    print(f"drain settled in {t_drain:.0f}s", flush=True)

    # ── questions ───────────────────────────────────────────────────────
    qa = []
    for ci, conv in enumerate(data):
        for q in conv["qa"]:
            qa.append({**q, "conv": ci, "ns": f"lc-{args.run_id}-{ci}"})
    if args.questions:
        random.Random(args.seed).shuffle(qa)
        qa = qa[: args.questions]

    cfg = json.loads(args.search_config)

    def run_q(q):
        body = {"query": q["question"], "namespace": q["ns"], **cfg}
        r = http(args.base_url, token, "/v1/search", body, timeout=120)
        mems = [{"content": x["content"]} for x in r.get("results", [])]
        ans = chat(args.llm_base, key, args.model,
                   answer_prompt(q["question"], None, mems),
                   max_tokens=4096, timeout=600, thinking=args.thinking)
        truth = str(q.get("answer") or ("not mentioned in the conversation" if str(q.get("category")) == "5" else ""))
        jr = chat(args.llm_base, key, args.model, judge_prompt(q["question"], truth, ans),
                  max_tokens=2000, timeout=600)
        return q, parse_judge(jr)["score"]

    t2 = time.time()
    per_cat = collections.defaultdict(lambda: [0, 0])
    failures = 0
    with ThreadPoolExecutor(max_workers=args.max_workers) as ex:
        futs = [ex.submit(run_q, q) for q in qa]
        for f in as_completed(futs):
            try:
                q, sc = f.result()
            except Exception as e:
                failures += 1
                print(f"ERROR question failed: {e}", flush=True)
                continue
            c = per_cat[str(q["category"])]
            c[0] += sc
            c[1] += 1
    t_eval = time.time() - t2

    tot = sum(v[1] for v in per_cat.values())
    cor = sum(v[0] for v in per_cat.values())
    out = {
        "run_id": args.run_id, "convs": len(data), "chunks": n_chunks,
        "n_questions": tot, "failures": failures,
        "overall": (100.0 * cor / tot) if tot else 0.0,
        "by_category": {k: {"acc": 100.0 * v[0] / v[1], "n": v[1]} for k, v in sorted(per_cat.items())},
        "timing_s": {"ingest": round(t_ingest), "drain": round(t_drain),
                     "eval": round(t_eval), "total": round(time.time() - t0)},
        "model": args.model, "search_config": cfg,
    }
    pathlib.Path(args.out).write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))
    if failures:
        raise SystemExit(f"{failures} questions failed — run INVALID for verdicts")


if __name__ == "__main__":
    main()
