#!/usr/bin/env python3
"""LongMemEval answerer+judge over a search-*.json arm produced by
bench_retrieval.py. Pure post-processing: no NovaMem calls, so the same
retrieval can be judged repeatedly without re-querying the memory system.

Answerer and judge are both the local qwen3 behind the gpustack gateway.
Record that when quoting numbers — these are NOT GPT-5/Gemini judged.
"""
import argparse
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib import request, error

_P = threading.Lock()


def log(m):
    with _P:
        print(m, flush=True)


def chat(base, key, model, prompt, max_tokens=256, timeout=240, attempts=3, thinking=False):
    # qwen3 is a reasoning model: left to its own devices it emits chain of
    # thought into `message.reasoning` and returns `content: null`, burning
    # the whole token budget before it writes an answer. Reading `content`
    # then yields "" for every call, the judge fails every empty answer,
    # and the run reports 0% that looks like a retrieval failure. Turning
    # thinking off puts the answer back in `content`.
    # With thinking on, the budget has to cover the chain of thought *and*
    # the answer, or content comes back empty for the same reason.
    payload = {"model": model, "messages": [{"role": "user", "content": prompt}],
               "temperature": 0,
               # 2048 was not enough for the longest aggregation questions:
               # one hit finish_reason=length after 7.6k chars of reasoning
               # with no answer written.
               "max_tokens": max(max_tokens, 4096) if thinking else max_tokens,
               "chat_template_kwargs": {"enable_thinking": bool(thinking)}}
    headers = {"content-type": "application/json", "accept": "application/json"}
    if key:
        headers["authorization"] = f"Bearer {key}"
    last = None
    for a in range(1, attempts + 1):
        try:
            r = request.Request(base.rstrip("/") + "/chat/completions",
                                data=json.dumps(payload).encode(), headers=headers, method="POST")
            with request.urlopen(r, timeout=timeout) as resp:
                out = json.loads(resp.read().decode())
            choice = (out.get("choices") or [{}])[0]
            msg = choice.get("message") or {}
            txt = msg.get("content") or ""
            txt = re.sub(r"<think>[\s\S]*?</think>", "", txt, flags=re.I).strip()
            if txt:
                return txt
            # Empty content is never a legitimate answer. Surface it rather
            # than letting it be scored as a wrong one.
            raise RuntimeError(
                f"empty completion (finish_reason={choice.get('finish_reason')}, "
                f"reasoning_chars={len(msg.get('reasoning') or '')})")
        except Exception as e:
            last = e
            time.sleep(min(2 ** (a - 1), 8))
    raise RuntimeError(f"chat failed: {last}")


def answer_prompt(q, qdate, mems):
    lines, total = [], 0
    for i, m in enumerate(mems, 1):
        t = (m.get("content") or "")[:8000]
        line = f"{i}. {t}"
        if total + len(line) > 180000:
            break
        lines.append(line)
        total += len(line)
    body = "\n".join(lines) if lines else "(No relevant memories found)"
    return f"""You are a personal assistant with access to memories from past conversations with a user. Answer the question using only the memories below. Be concise.

Rules:
- If the memories contain enough information, answer directly.
- If the question asks for suggestions, recommendations, tips, or advice:
  DO give them. Ground every suggestion in the user's stated preferences,
  plans, possessions, and constraints from the memories (mention which),
  and tailor it to them specifically — a generic answer that ignores what
  the memories say about the user is wrong. Never refuse these.
- Only for FACTUAL questions whose answer is genuinely absent from the
  memories, say: The information provided is not enough.
- For conflicting facts, prefer the most recent memory.
- For temporal/counting questions, compute carefully from the dates in the memories.

Question date: {qdate or ''}
Question: {q}

Memories:
{body}

Answer only, no hidden reasoning:"""


def judge_prompt(q, truth, hyp):
    return f"""Judge whether the model response correctly answers the question according to the ground truth. Use semantic equivalence, not exact wording.

Return JSON only in this exact shape:
{{"judgment":"PASS" or "FAIL", "score": 1 or 0, "reason":"short reason"}}

Question: {q}
Ground truth answer: {truth}
Model response: {hyp}"""


def parse_judge(t):
    m = re.search(r"\{[\s\S]*\}", t or "")
    if m:
        try:
            o = json.loads(m.group(0))
            j = str(o.get("judgment", "")).upper()
            s = int(float(o.get("score", 1 if j == "PASS" else 0)) >= 0.5)
            return {"judgment": "PASS" if s else "FAIL", "score": s, "reason": str(o.get("reason", ""))[:200]}
        except Exception:
            pass
    u = (t or "").upper()
    s = 1 if "PASS" in u and "FAIL" not in u else 0
    return {"judgment": "PASS" if s else "FAIL", "score": s, "reason": "fallback parse"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arm", required=True, help="path to search-<name>.json")
    ap.add_argument("--ingest", required=True, help="path to ingest.json (for question/answer text)")
    ap.add_argument("--llm-base", default="http://192.168.10.125/v1")
    ap.add_argument("--key-file", required=True)
    ap.add_argument("--model", default="qwen3-6-35b-a3b-nvfp4")
    ap.add_argument("--cutoffs", default="10,50")
    ap.add_argument("--max-workers", type=int, default=4)
    ap.add_argument("--thinking", action="store_true",
                    help="Let the answerer reason before answering (helps counting/aggregation)")
    ap.add_argument("--out")
    args = ap.parse_args()

    key = Path(args.key_file).read_text().strip()
    arm = json.loads(Path(args.arm).read_text())
    meta = json.loads(Path(args.ingest).read_text())["questions"]
    # "all" evaluates each question's full returned set. With a token
    # budget the server has already sized each result set correctly;
    # forcing a uniform cutoff re-truncates to the *smallest* question's
    # count and starves every other one — which silently halved the
    # context in an earlier run and made a budget-filled config look far
    # worse than it was.
    cutoffs = ["all"] if args.cutoffs.strip() == "all" else [int(c) for c in args.cutoffs.split(",")]

    # The arm only carries verbatim content for the slice the search stage
    # was told to keep (--store-content). Judging past that would silently
    # feed the answerer empty memories and score it as a retrieval failure,
    # so refuse rather than under-report.
    have = min((sum(1 for t in q.get("top_ranked", []) if t.get("content"))
                for q in arm["per_question"]), default=0)
    over = [c for c in cutoffs if c != "all" and c > have]
    if over:
        raise SystemExit(f"cutoffs {over} exceed the {have} results carrying verbatim content; "
                         f"re-run `bench_retrieval.py search --store-content {max(cutoffs)}`")

    def one(q):
        qid = q["question_id"]
        m = meta[qid]
        res = {"question_id": qid, "question_type": q["question_type"], "cutoffs": {}}
        for k in cutoffs:
            rows = q.get("top_ranked", [])
            mems = [{"content": t.get("content", "")}
                    for t in (rows if k == "all" else rows[:k])]
            ans = chat(args.llm_base, key, args.model, answer_prompt(m["question"], m.get("question_date"), mems), thinking=args.thinking)
            jr = chat(args.llm_base, key, args.model, judge_prompt(m["question"], m.get("answer", ""), ans), max_tokens=180)
            j = parse_judge(jr)
            res["cutoffs"][f"top_{k}"] = {"answer": ans, "judge": j, "score": j["score"],
                                          "n_memories": len(mems)}
            log(f"{qid} top_{k}: {j['judgment']} ({len(mems)} memories)")
        return res

    out = []
    with ThreadPoolExecutor(max_workers=args.max_workers) as pool:
        futs = [pool.submit(one, q) for q in arm["per_question"]]
        for f in as_completed(futs):
            try:
                out.append(f.result())
            except Exception as e:
                log(f"ERROR: {e}")

    types = sorted({o["question_type"] for o in out})
    summary = {}
    for k in cutoffs:
        key_ = f"top_{k}"
        vals = [o["cutoffs"][key_]["score"] for o in out if key_ in o["cutoffs"]]
        summary[key_] = {
            "overall": {"total": len(vals), "correct": sum(vals),
                        "accuracy": (sum(vals) / len(vals) * 100) if vals else 0},
            "by_question_type": {
                t: {"total": len([o for o in out if o["question_type"] == t and key_ in o["cutoffs"]]),
                    "correct": sum(o["cutoffs"][key_]["score"] for o in out if o["question_type"] == t and key_ in o["cutoffs"]),
                    "accuracy": (sum(o["cutoffs"][key_]["score"] for o in out if o["question_type"] == t and key_ in o["cutoffs"]) /
                                 max(1, len([o for o in out if o["question_type"] == t and key_ in o["cutoffs"]])) * 100)}
                for t in types},
        }
    report = {"arm": arm["config_name"], "answerer_model": args.model, "answerer_thinking": args.thinking, "judge_model": args.model,
              "provider": "novamem-live-gpustack-qwen3", "n": len(out),
              "metrics_by_cutoff": summary, "evaluations": out}
    p = Path(args.out or (Path(args.arm).parent / f"answers-{arm['config_name']}.json"))
    p.write_text(json.dumps(report, indent=2))
    log(json.dumps(summary, indent=2))
    log(f"wrote {p}")


if __name__ == "__main__":
    main()
