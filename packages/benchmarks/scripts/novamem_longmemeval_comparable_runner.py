#!/usr/bin/env python3
"""Mem0-style LongMemEval runner for live NovaMem.

Key properties:
- question-level concurrency via --max-workers
- per-question JSON checkpoints under <out-dir>/questions/
- --predict-only: ingest + search only, no answerer/judge calls
- --evaluate-only: answerer/judge from existing per-question retrieval checkpoints, no NovaMem calls
- one isolated namespace per question inside one disposable project/run
"""

import argparse
import json
import os
import re
import sys
import time
import uuid
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib import request, error

import ijson


_WRITE_LOCK = threading.Lock()
_PRINT_LOCK = threading.Lock()


def log(msg):
    with _PRINT_LOCK:
        print(msg, flush=True)


def safe_name(value):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value))[:160] or "unknown"


def atomic_write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".tmp.{os.getpid()}.{threading.get_ident()}")
    tmp.write_text(
        json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    os.replace(tmp, path)


def http_json(method, url, token=None, payload=None, timeout=120, attempts=3):
    headers = {"accept": "application/json"}
    data = None
    if token:
        headers["authorization"] = f"Bearer {token}"
    if payload is not None:
        headers["content-type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    last_error = None
    for attempt in range(1, attempts + 1):
        req = request.Request(url, data=data, headers=headers, method=method)
        try:
            with request.urlopen(req, timeout=timeout) as resp:
                text = resp.read().decode("utf-8")
                return json.loads(text) if text else None
        except error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")
            last_error = RuntimeError(f"{method} {url} HTTP {e.code}: {body[:800]}")
            if e.code not in {429, 500, 502, 503, 504} or attempt >= attempts:
                raise last_error from e
        except Exception as e:
            last_error = RuntimeError(f"{method} {url} failed: {e}")
            if attempt >= attempts:
                raise last_error from e
        time.sleep(min(2 ** (attempt - 1), 8))
    raise last_error or RuntimeError(f"{method} {url} failed")


def vllm_generate(base_url, model, prompt, max_tokens=256, temperature=0, timeout=240):
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    out = http_json(
        "POST",
        base_url.rstrip("/") + "/chat/completions",
        None,
        payload,
        timeout=timeout,
    )
    text = (((out or {}).get("choices") or [{}])[0].get("message") or {}).get(
        "content"
    ) or ""
    text = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.I).strip()
    text = re.sub(
        r"<mem_thinking>[\s\S]*?</mem_thinking>", "", text, flags=re.I
    ).strip()
    return text


def create_project(base_url, token, name):
    obj = http_json(
        "POST", base_url.rstrip("/") + "/v1/me/projects", token, {"name": name}
    )
    return str(obj["id"])


def delete_project(base_url, token, project):
    return http_json(
        "DELETE", base_url.rstrip("/") + f"/v1/me/projects/{project}", token
    )


def chunks_for_session(question_id, session_id, date, turns, turns_per_chunk=2):
    clean = [t for t in turns if (t.get("content") or "").strip()]
    for idx in range(0, len(clean), turns_per_chunk):
        part = clean[idx : idx + turns_per_chunk]
        lines = [
            f"[LongMemEval question={question_id} session={session_id} chunk={idx // turns_per_chunk}]",
            f"Session: {session_id}",
            f"Date: {date}",
        ]
        for t in part:
            lines.append(
                f"{t.get('role', 'speaker')}: {(t.get('content') or '').strip()}"
            )
        yield "\n".join(lines), idx // turns_per_chunk


def remember(base_url, token, project, namespace, content, metadata):
    """Mem0 add()-equivalent ingestion path for LongMemEval.

    This is the benchmark ingestion path: direct store + embed + vector upsert,
    matching Mem0's `add()` benchmark shape rather than NovaMem's agent-facing
    semantic capture workflow.
    """
    return http_json(
        "POST",
        base_url.rstrip("/") + "/v1/remember",
        token,
        {
            "content": content,
            "namespace": namespace,
            "project": project,
            "force": True,
            "metadata": metadata,
            "sourceType": "benchmark",
            "source": "novamem-longmemeval-comparable-runner",
            "sensitivity": "internal",
        },
        timeout=180,
    )


def search(base_url, token, project, namespace, query, k):
    obj = http_json(
        "POST",
        base_url.rstrip("/") + "/v1/search",
        token,
        {
            "query": query,
            "k": k,
            "namespace": namespace,
            "project": project,
            "maxSensitivity": "sensitive",
        },
        timeout=180,
    )
    return (obj or {}).get("results") or []


def format_memories(rows, max_chars_each=8000, max_total_chars=180000):
    lines = []
    total = 0
    for i, r in enumerate(rows, 1):
        mem = (r.get("content") or r.get("text") or r.get("memory") or "").strip()
        if len(mem) > max_chars_each:
            mem = mem[:max_chars_each] + "…"
        line = f"{i}. {mem}"
        if total + len(line) > max_total_chars:
            break
        lines.append(line)
        total += len(line)
    return "\n".join(lines) if lines else "(No relevant memories found)"


def answer_prompt(question, question_date, memories):
    return f"""You are a personal assistant with access to memories from past conversations with a user. Answer the question using only the memories below. Be concise.

Rules:
- If the memories contain enough information, answer directly.
- If the answer is not supported, say: The information provided is not enough.
- For conflicting facts, prefer the most recent memory.
- For temporal/counting questions, compute carefully from the dates in the memories.

Question date: {question_date or ""}
Question: {question}

Memories:
{format_memories(memories)}

Answer only, no hidden reasoning:"""


def judge_prompt(question, answer, hypothesis):
    return f"""Judge whether the model response correctly answers the question according to the ground truth. Use semantic equivalence, not exact wording.

Return JSON only in this exact shape:
{{"judgment":"PASS" or "FAIL", "score": 1 or 0, "reason":"short reason"}}

Question: {question}
Ground truth answer: {answer}
Model response: {hypothesis}"""


def parse_judge(text):
    m = re.search(r"\{[\s\S]*\}", text or "")
    if m:
        try:
            obj = json.loads(m.group(0))
            judgment = str(obj.get("judgment", "")).upper()
            score = int(float(obj.get("score", 1 if judgment == "PASS" else 0)) >= 0.5)
            return {
                "judgment": "PASS" if score else "FAIL",
                "score": score,
                "reason": str(obj.get("reason", "")),
                "raw": text[:500],
            }
        except Exception:
            pass
    upper = (text or "").upper()
    score = 1 if "PASS" in upper and "FAIL" not in upper else 0
    return {
        "judgment": "PASS" if score else "FAIL",
        "score": score,
        "reason": "fallback parse",
        "raw": (text or "")[:500],
    }


def aggregate(evaluations, cutoffs, run_meta):
    by_cutoff = {}
    qtypes = sorted({e["question_type"] for e in evaluations})
    for k in cutoffs:
        key = f"top_{k}"
        vals = [
            e["cutoffs"][key]["score"]
            for e in evaluations
            if key in e.get("cutoffs", {})
        ]
        by_type = {}
        for qt in qtypes:
            tvals = [
                e["cutoffs"][key]["score"]
                for e in evaluations
                if e["question_type"] == qt and key in e.get("cutoffs", {})
            ]
            by_type[qt] = {
                "total": len(tvals),
                "correct": sum(tvals),
                "accuracy": (sum(tvals) / len(tvals) * 100) if tvals else 0,
                "avg_score": (sum(tvals) / len(tvals) * 100) if tvals else 0,
            }
        by_cutoff[key] = {
            "overall": {
                "total": len(vals),
                "correct": sum(vals),
                "accuracy": (sum(vals) / len(vals) * 100) if vals else 0,
                "avg_score": (sum(vals) / len(vals) * 100) if vals else 0,
            },
            "by_question_type": by_type,
        }
    return {
        "metadata": {
            **run_meta,
            "top_k": max(cutoffs),
            "top_k_cutoffs": [f"top_{k}" for k in cutoffs],
            "total_questions": len(evaluations),
            "question_types": qtypes,
        },
        "metrics_by_cutoff": by_cutoff,
        "evaluations": sorted(evaluations, key=lambda e: e.get("dataset_index", 0)),
    }


def load_json(path, default=None):
    path = Path(path)
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def question_checkpoint_path(out_dir, qid):
    return Path(out_dir) / "questions" / f"{safe_name(qid)}.json"


def build_search_result_rows(retrieved, answer_session_ids):
    rows = []
    memories = []
    for idx, r in enumerate(retrieved, 1):
        content = r.get("content") or r.get("text") or ""
        sid_match = re.search(r"session=([^\s\]]+)", content)
        sid = sid_match.group(1) if sid_match else None
        rid = str(r.get("id"))
        rows.append(
            {
                "id": rid,
                "rank": idx,
                "session_id": sid,
                "score": r.get("score"),
                "relevant": sid in answer_session_ids,
            }
        )
        memories.append(
            {"id": rid, "rank": idx, "content": content, "score": r.get("score")}
        )
    return rows, memories


def process_question(
    item, dataset_index, ordinal, args, token, project, run_id, cutoffs, out_dir
):
    qid = str(item["question_id"])
    qpath = question_checkpoint_path(out_dir, qid)
    cp = load_json(qpath, default={}) or {}
    ns = cp.get("namespace") or f"lme-{run_id}-{qid}"[:120]
    q_start = time.time()
    answer_session_ids = set(item.get("answer_session_ids") or [])

    if cp.get("status") == "evaluated" and not args.rejudge:
        log(f"[{ordinal}] {qid} already evaluated")
        return cp.get("evaluation")

    if args.evaluate_only and not cp.get("retrieved_memories"):
        raise RuntimeError(
            f"{qid}: evaluate-only requires checkpointed retrieved_memories in {qpath}"
        )

    if not args.evaluate_only and not cp.get("ingested"):
        log(
            f"[{ordinal}] {qid} {item.get('question_type')} ingest sessions={len(item.get('haystack_sessions') or [])}"
        )
        stored_chunks = 0
        for sid, date, sess in zip(
            item.get("haystack_session_ids") or [],
            item.get("haystack_dates") or [],
            item.get("haystack_sessions") or [],
        ):
            for content, chunk_idx in chunks_for_session(qid, sid, date, sess):
                remember(
                    args.base_url,
                    token,
                    project,
                    ns,
                    content,
                    {
                        "benchmark": "longmemeval",
                        "question_id": qid,
                        "question_type": item.get("question_type"),
                        "session_id": sid,
                        "chunk": chunk_idx,
                        "session_date": date,
                    },
                )
                stored_chunks += 1
        cp.update(
            {
                "question_id": qid,
                "dataset_index": dataset_index,
                "question_type": item.get("question_type"),
                "namespace": ns,
                "stored_chunks": stored_chunks,
                "ingested": True,
                "status": "ingested",
                "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        )
        atomic_write_json(qpath, cp)

    if not args.evaluate_only and not cp.get("retrieved_memories"):
        log(f"[{ordinal}] {qid} search top_{max(cutoffs)}")
        retrieved = search(
            args.base_url, token, project, ns, item["question"], max(cutoffs)
        )
        search_results, retrieved_memories = build_search_result_rows(
            retrieved, answer_session_ids
        )
        cp.update(
            {
                "question_id": qid,
                "dataset_index": dataset_index,
                "question_type": item.get("question_type"),
                "namespace": ns,
                "retrieval": {"search_results": search_results},
                "retrieved_memories": retrieved_memories,
                "retrieved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "status": "predicted",
                "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        )
        atomic_write_json(qpath, cp)

    if args.predict_only:
        log(
            f"[{ordinal}] {qid} predicted retrieved={len(cp.get('retrieved_memories') or [])}"
        )
        return None

    cutoff_results = dict((cp.get("evaluation") or {}).get("cutoffs") or {})
    retrieved_memories = cp.get("retrieved_memories") or []
    for k in cutoffs:
        key = f"top_{k}"
        if key in cutoff_results and not args.rejudge:
            continue
        top = retrieved_memories[:k]
        ans = vllm_generate(
            args.vllm_base_url,
            args.model,
            answer_prompt(item["question"], item.get("question_date"), top),
            max_tokens=256,
            temperature=0,
        )
        judge_raw = vllm_generate(
            args.vllm_base_url,
            args.model,
            judge_prompt(item["question"], item.get("answer", ""), ans),
            max_tokens=180,
            temperature=0,
        )
        judge = parse_judge(judge_raw)
        cutoff_results[key] = {
            "generated_answer": ans,
            "judge": judge,
            "score": judge["score"],
            "retrieved_count": len(top),
        }
        log(
            f"[{ordinal}] {qid} {key}: {judge['judgment']} | {ans[:100].replace(chr(10), ' ')}"
        )
        cp_eval = {**(cp.get("evaluation") or {}), "cutoffs": cutoff_results}
        cp["evaluation"] = cp_eval
        cp["status"] = "evaluating"
        cp["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        atomic_write_json(qpath, cp)

    ev = {
        "question_id": qid,
        "dataset_index": dataset_index,
        "question_type": item.get("question_type"),
        "question": item.get("question"),
        "question_date": item.get("question_date"),
        "ground_truth_answer": item.get("answer"),
        "answer_session_ids": list(answer_session_ids),
        "stored_chunks": cp.get("stored_chunks", 0),
        "retrieval": cp.get("retrieval", {"search_results": []}),
        "cutoffs": cutoff_results,
        "latency_ms": int((time.time() - q_start) * 1000),
    }
    cp["evaluation"] = ev
    cp["status"] = "evaluated"
    cp["evaluated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    cp["updated_at"] = cp["evaluated_at"]
    atomic_write_json(qpath, cp)
    return ev


def iter_dataset_items(dataset, offset, limit):
    seen = 0
    processed = 0
    with open(dataset, "rb") as f:
        for item in ijson.items(f, "item"):
            if seen < offset:
                seen += 1
                continue
            if limit and processed >= limit:
                break
            dataset_index = seen
            seen += 1
            processed += 1
            yield dataset_index, processed - 1, item


def collect_evaluations(out_dir):
    qdir = Path(out_dir) / "questions"
    evaluations = []
    if not qdir.exists():
        return evaluations
    for path in qdir.glob("*.json"):
        cp = load_json(path, default={}) or {}
        ev = cp.get("evaluation")
        if cp.get("status") == "evaluated" and ev:
            evaluations.append(ev)
    return sorted(evaluations, key=lambda e: e.get("dataset_index", 0))


def write_outputs(out_dir, evaluations, cutoffs, run_meta):
    out_dir = Path(out_dir)
    eval_path = out_dir / "evaluations.jsonl"
    summary_path = out_dir / "comparable_report.json"
    evaluations = sorted(evaluations, key=lambda e: e.get("dataset_index", 0))
    with _WRITE_LOCK:
        with eval_path.open("w", encoding="utf-8") as ef:
            for ev in evaluations:
                ef.write(json.dumps(ev, ensure_ascii=False) + "\n")
        report = aggregate(evaluations, cutoffs, run_meta)
        atomic_write_json(summary_path, report)
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--base-url", default="http://192.168.10.248:7778")
    ap.add_argument("--token-file", default="/home/piwi/.hermes/secrets/novamem_token")
    ap.add_argument("--vllm-base-url", default="http://192.168.10.246:8888/v1")
    ap.add_argument("--model", default="qwen3.6-35b")
    ap.add_argument("--cutoffs", default="10,20,50,200")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--cleanup", action="store_true")
    ap.add_argument("--run-id", default=None)
    ap.add_argument(
        "--max-workers",
        type=int,
        default=1,
        help="Parallel questions to process (Mem0 default is 10; start with 5 for NovaMem/vLLM).",
    )
    ap.add_argument(
        "--predict-only",
        action="store_true",
        help="Only ingest and search; skip answerer/judge.",
    )
    ap.add_argument(
        "--evaluate-only",
        action="store_true",
        help="Only answer/judge from checkpointed retrieval; no NovaMem calls.",
    )
    ap.add_argument(
        "--rejudge",
        action="store_true",
        help="Re-run answerer/judge even when checkpointed cutoff results exist.",
    )
    args = ap.parse_args()

    if args.predict_only and args.evaluate_only:
        raise SystemExit("--predict-only and --evaluate-only are mutually exclusive")
    if args.max_workers < 1:
        raise SystemExit("--max-workers must be >= 1")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "questions").mkdir(parents=True, exist_ok=True)
    state_path = out_dir / "state.json"
    cutoffs = sorted({int(x.strip()) for x in args.cutoffs.split(",") if x.strip()})
    token = Path(args.token_file).read_text().strip()
    run_id = (
        args.run_id
        or f"novamem-lme-{time.strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:6]}"
    )

    state = load_json(state_path, default=None)
    if state:
        project = state.get("project")
        run_id = state["run_id"]
    else:
        project = (
            None if args.evaluate_only else create_project(args.base_url, token, run_id)
        )
        state = {
            "run_id": run_id,
            "project": project,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "cleanup": args.cleanup,
            "mode": "predict-only"
            if args.predict_only
            else "evaluate-only"
            if args.evaluate_only
            else "answerer",
            "max_workers": args.max_workers,
            "question_checkpoints_dir": str(out_dir / "questions"),
        }
        atomic_write_json(state_path, state)
    if args.evaluate_only and not project:
        log(
            "evaluate-only: no project in state; NovaMem calls are disabled as requested"
        )

    run_meta = {
        "benchmark": "longmemeval",
        "project_name": "NovaMem live",
        "run_id": run_id,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mode": "predict-only"
        if args.predict_only
        else "evaluate-only"
        if args.evaluate_only
        else "answerer",
        "answerer_model": None if args.predict_only else args.model,
        "judge_model": None if args.predict_only else args.model,
        "provider": "novamem-live-local-vllm",
        "novamem_base_url": args.base_url,
        "vllm_base_url": args.vllm_base_url,
        "dataset": args.dataset,
        "max_workers": args.max_workers,
        "checkpointing": "per-question-json",
    }

    log(
        f"run_id={run_id} project={project} out_dir={out_dir} max_workers={args.max_workers} mode={run_meta['mode']}"
    )
    log(
        f"opening dataset={args.dataset} offset={args.offset} limit={args.limit or 'all'} cutoffs={cutoffs}"
    )

    items = list(iter_dataset_items(args.dataset, args.offset, args.limit))
    started = time.time()
    failures = []
    evaluations = collect_evaluations(out_dir)

    with ThreadPoolExecutor(max_workers=args.max_workers) as pool:
        futures = []
        for dataset_index, ordinal, item in items:
            futures.append(
                pool.submit(
                    process_question,
                    item,
                    dataset_index,
                    ordinal,
                    args,
                    token,
                    project,
                    run_id,
                    cutoffs,
                    out_dir,
                )
            )
        for fut in as_completed(futures):
            try:
                ev = fut.result()
                if ev:
                    evaluations = collect_evaluations(out_dir)
                    report = write_outputs(out_dir, evaluations, cutoffs, run_meta)
                    elapsed = time.time() - started
                    log(
                        f"completed_evaluations={len(evaluations)} elapsed_min={elapsed / 60:.1f} report={out_dir / 'comparable_report.json'}"
                    )
            except Exception as exc:
                failures.append(str(exc))
                log(f"ERROR: {exc}")

    evaluations = collect_evaluations(out_dir)
    report = write_outputs(out_dir, evaluations, cutoffs, run_meta)
    state["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    state["failures"] = failures
    state["completed_evaluations"] = len(evaluations)
    if args.predict_only:
        predicted = len(list((out_dir / "questions").glob("*.json")))
        state["completed_predictions"] = predicted
    atomic_write_json(state_path, state)

    if failures:
        log(f"failures={len(failures)}; leaving project/checkpoints intact for resume")
    elif args.cleanup and not args.predict_only and not args.evaluate_only and project:
        log(f"cleanup project={project}")
        delete_project(args.base_url, token, project)
        state["cleaned_up_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        atomic_write_json(state_path, state)

    print(
        json.dumps(
            {
                "report": str(out_dir / "comparable_report.json"),
                "state": str(state_path),
                "questions_dir": str(out_dir / "questions"),
                "evaluations": len(evaluations),
                "failures": failures,
                "metrics_by_cutoff": report["metrics_by_cutoff"],
            },
            indent=2,
        )
    )
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
