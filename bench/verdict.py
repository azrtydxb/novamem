#!/usr/bin/env python3
"""Compare a quick-gate run against the recorded baseline.

Prints aggregate accuracy per replication, the mean, and a question-level
flip analysis against the baseline's per-question scores — the aggregate
alone hides whether a change moved the same questions consistently
(systematic) or different ones per replication (noise). Appends the run
to baselines.json history so the next change compares against this one
if it is promoted with --promote.
"""
import argparse
import json
import pathlib


def load_scores(path: str) -> dict[str, bool]:
    d = json.load(open(path))
    return {
        r["question_id"]: bool(r["cutoffs"]["top_all"]["score"])
        for r in d["evaluations"]
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--baselines", default="baselines.json")
    ap.add_argument("--promote", action="store_true",
                    help="record this run as the new baseline on top of printing the verdict")
    args = ap.parse_args()

    out = pathlib.Path(args.out_dir)
    reps = sorted(out.glob("answers-rep*.json"))
    if not reps:
        raise SystemExit("no answers-rep*.json in " + args.out_dir)
    runs = [load_scores(str(p)) for p in reps]

    bpath = pathlib.Path(args.baselines)
    book = json.loads(bpath.read_text()) if bpath.exists() else {"current": None, "history": []}

    accs = [100.0 * sum(r.values()) / len(r) for r in runs]
    print(f"\n=== {args.label} ===")
    for i, a in enumerate(accs, 1):
        print(f"  rep{i}: {a:.1f}%  (n={len(runs[i-1])})")
    mean = sum(accs) / len(accs)
    print(f"  mean: {mean:.1f}%")

    base = book.get("current")
    if base:
        bscores = {k: bool(v) for k, v in base["scores"].items()}
        # A question counts as moved only if it moved the same way in EVERY
        # replication — same discipline as the phase gates.
        common = set(bscores) & set.intersection(*(set(r) for r in runs))
        gained = [q for q in common if not bscores[q] and all(r[q] for r in runs)]
        lost = [q for q in common if bscores[q] and all(not r[q] for r in runs)]
        print(f"  vs baseline '{base['label']}' ({base['mean']:.1f}%): "
              f"{mean - base['mean']:+.1f}pp | systematic gains {len(gained)}, losses {len(lost)}")
        if gained:
            print("    gained:", ", ".join(sorted(gained)[:10]))
        if lost:
            print("    lost:  ", ", ".join(sorted(lost)[:10]))
        band = 4.0  # ±2 questions at n=50
        if not gained and not lost and abs(mean - base["mean"]) < band:
            print("  VERDICT: parity (inside the ±2-question noise band, no systematic flips)")
        elif len(gained) > len(lost) and mean >= base["mean"]:
            print("  VERDICT: improvement")
        elif len(lost) > len(gained) and mean <= base["mean"]:
            print("  VERDICT: regression")
        else:
            print("  VERDICT: mixed — replicate more or inspect the flipped questions")
    else:
        print("  no baseline recorded yet — promoting this run")
        args.promote = True

    entry = {
        "label": args.label,
        "mean": mean,
        "reps": accs,
        # Majority vote across replications, so the stored per-question
        # baseline is the stable signal, not one replication's coin-flips.
        "scores": {q: sum(r.get(q, False) for r in runs) * 2 > len(runs)
                   for q in set().union(*runs)},
    }
    book["history"].append({"label": args.label, "mean": mean, "reps": accs})
    if args.promote:
        book["current"] = entry
        print(f"  promoted '{args.label}' as the new baseline")
    bpath.write_text(json.dumps(book, indent=1))


if __name__ == "__main__":
    main()
