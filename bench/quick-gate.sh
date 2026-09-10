#!/bin/bash
# quick-gate — the fast iteration loop for retrieval changes.
#
# Answers "did my change improve or regress answer accuracy?" in ~15 min
# by re-searching a STANDING benchmark corpus (no re-ingest) and running
# the LLM answer eval on a fixed 50-question stratified subset, twice.
#
#   ./quick-gate.sh my-change                            # current best config
#   ./quick-gate.sh my-change --config '{"rerank":false}'  # override merged in
#   ./quick-gate.sh my-change --reps 3
#
# Requirements (env or flags):
#   NOVAMEM_BENCH_URL    bench server   (default http://192.168.10.121:7778)
#   NOVAMEM_BENCH_TOKEN  bearer token   (or --token-file)
#   FASTLLM_BASE         answerer/judge (default http://192.168.10.125/v1)
#   FASTLLM_KEY_FILE     api key file   (or --key-file)
#
# The standing corpus is run-id `p6` (all 500 LongMemEval_s questions,
# capture write path) living on the bench deployment. DO NOT purge the
# `nb-p6-*` namespaces — re-ingesting them costs ~10 h. Write-path
# changes DO need a fresh corpus: use --reingest, which ingests the same
# 50-question subset under a dated run-id (~1.5 h including drain).
#
# Verdict: compares against bench/baselines.json (question-level scores,
# not just the aggregate) and prints gains/losses. n=50 noise band is
# ±2 questions (±4 pp) per replication — treat anything inside that as
# parity; the full 500-question run remains the release gate.
set -euo pipefail
cd "$(dirname "$0")"

LABEL="${1:?usage: quick-gate.sh <label> [--config json] [--reps N] [--reingest]}"
shift
CONFIG_OVERRIDE="{}"
REPS=2
REINGEST=0
TOKEN_FILE="${NOVAMEM_BENCH_TOKEN_FILE:-}"
KEY_FILE="${FASTLLM_KEY_FILE:-}"
while [ $# -gt 0 ]; do
	case "$1" in
	--config)
		CONFIG_OVERRIDE="$2"
		shift 2
		;;
	--reps)
		REPS="$2"
		shift 2
		;;
	--reingest)
		REINGEST=1
		shift
		;;
	--token-file)
		TOKEN_FILE="$2"
		shift 2
		;;
	--key-file)
		KEY_FILE="$2"
		shift 2
		;;
	*)
		echo "unknown arg $1" >&2
		exit 2
		;;
	esac
done
BASE="${NOVAMEM_BENCH_URL:-http://192.168.10.121:7778}"
LLM="${FASTLLM_BASE:-http://192.168.10.125/v1}"
MODEL="${FASTLLM_MODEL:-qwen3-6-35b-a3b-nvfp4}"
[ -n "$TOKEN_FILE" ] || {
	echo "need NOVAMEM_BENCH_TOKEN_FILE or --token-file" >&2
	exit 2
}
[ -n "$KEY_FILE" ] || {
	echo "need FASTLLM_KEY_FILE or --key-file" >&2
	exit 2
}

PY="${PYTHON:-python3}"
OUT="quick-runs/$LABEL"
mkdir -p "$OUT"

REF=ref50
if [ "$REINGEST" = "1" ]; then
	REF="qg$(date -u +%m%d%H%M)"
	$PY bench_retrieval.py ingest --dataset longmemeval_s_cleaned.json --out-dir "$OUT" \
		--token-file "$TOKEN_FILE" --run-id "$REF" --limit 50 --max-workers 8 --write-path capture
	echo "waiting for fact drain..."
	while :; do
		n=$(curl -s -m 20 "$BASE/v1/stats" -H "Authorization: Bearer $(cat "$TOKEN_FILE")" | $PY -c "import json,sys;print(json.load(sys.stdin).get('pendingFacts') or 0)" 2>/dev/null || echo 1)
		[ "$n" = "0" ] && break
		echo "  pending=$n"
		sleep 60
	done
else
	# Build the 50-question reference view over the standing p6 corpus once.
	$PY - "$OUT" <<'EOF'
import json, pathlib, sys
out = pathlib.Path(sys.argv[1])
ref = pathlib.Path("ref50-ingest.json")
if not ref.exists():
    full = json.load(open("p6-ingest.json"))          # snapshot of the standing corpus
    sub = json.load(open("ref50-qids.json"))          # the frozen 50 stratified qids
    qs = {q: full["questions"][q] for q in sub}
    missing = [q for q in sub if q not in full["questions"]]
    if missing:
        raise SystemExit(f"standing corpus is missing {len(missing)} reference questions: {missing[:5]}")
    ref.write_text(json.dumps({"questions": qs}, indent=1))
(out / "ingest.json").write_text(ref.read_text())
EOF
fi
[ -f "$OUT/ingest.json" ] || cp "ref50-ingest.json" "$OUT/ingest.json"

# Search with the campaign-best defaults, override merged on top.
CFG=$($PY -c "
import json,sys
best={'weights':{'keyword':0,'vector':1,'graph':0,'recency':0,'entity':0},'maxTokens':6000,'k':20,'rerank':True}
best.update(json.loads('$CONFIG_OVERRIDE'))
print(json.dumps(best))")
$PY relevant_counts.py --ingest "$OUT/ingest.json" --out "$OUT/relevant.json"
$PY bench_retrieval.py search --out-dir "$OUT" --token-file "$TOKEN_FILE" \
	--max-workers 2 --cutoffs 10,20 --name "$LABEL" \
	--relevant-counts "$OUT/relevant.json" --store-content 20 --config "$CFG"

for rep in $(seq 1 "$REPS"); do
	$PY answer_eval.py --arm "$OUT/search-$LABEL.json" --ingest "$OUT/ingest.json" \
		--key-file "$KEY_FILE" --llm-base "$LLM" --model "$MODEL" \
		--cutoffs all --max-workers 6 --thinking --out "$OUT/answers-rep$rep.json"
done

$PY verdict.py --label "$LABEL" --out-dir "$OUT" --baselines baselines.json
