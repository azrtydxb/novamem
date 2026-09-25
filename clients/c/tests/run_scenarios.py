"""Runs the shared scenario suite (clients/contract/scenarios.json) through
a C or C++ runner binary, one process per scenario.

    python3 tests/run_scenarios.py build/scenarios_c

NOVAMEM_WRAP, when set, prefixes each run (the Makefile's memcheck target
sets it to valgrind). Exits 1 listing every failure.
"""

import json
import os
import shlex
import subprocess
import sys
import urllib.request
from pathlib import Path

CONTRACT = Path(__file__).resolve().parents[2] / "contract"
SCEN = json.loads((CONTRACT / "scenarios.json").read_text())
TOKEN = SCEN["token"]


def subset(want, got, path="$"):
    if isinstance(want, dict):
        if not isinstance(got, dict):
            return f"{path}: want an object, got {got!r}"
        for k, v in want.items():
            d = subset(v, got.get(k), f"{path}.{k}")
            if d:
                return d
        return ""
    return "" if want == got else f"{path}: got {got!r}, want {want!r}"


def main():
    binary = sys.argv[1]
    wrap = shlex.split(os.environ.get("NOVAMEM_WRAP", ""))
    proc = subprocess.Popen(
        ["sh", "scenario-server.sh", "-scenarios", "scenarios.json"],
        cwd=CONTRACT,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        _, url, closed = proc.stdout.readline().split()
        closed = closed.split("=")[1]
        failures = []
        for s in SCEN["scenarios"]:
            sid, call, exp = s["id"], s["call"], s["expect"]
            if "cancel" in s.get("requires", []):
                print(f"skip (the blocking C API has no cancellation): {sid}")
                continue
            if call["class"] == "ctor":
                base, token, method, args = (
                    call["args"]["baseUrl"].replace("<server>", url),
                    call["args"]["token"],
                    "ctor",
                    "{}",
                )
            else:
                refused = '"refused"' in json.dumps(s.get("respond"))
                base = (
                    f"http://127.0.0.1:{closed}/s/{sid}"
                    if refused
                    else f"{url}/s/{sid}"
                )
                token, method, args = TOKEN, call["method"], json.dumps(call["args"])
            r = subprocess.run(
                [*wrap, binary, base, token, str(SCEN["timeoutMs"]), method, args],
                capture_output=True,
                text=True,
                check=False,  # the exit code is inspected below
            )
            if r.returncode != 0:
                failures.append(
                    f"{sid}: runner exited {r.returncode}: {r.stderr.strip()[-400:]}"
                )
                continue
            outcome, retryable, status, code, rest = (
                r.stdout.rstrip("\n").split(" ", 4) + [""] * 5
            )[:5]
            if outcome != exp["outcome"]:
                failures.append(
                    f"{sid}: outcome {outcome} ({rest}), want {exp['outcome']}"
                )
            if TOKEN in r.stdout:
                failures.append(f"{sid}: token leaked")
            if outcome not in ("ok", "empty"):
                if "retryable" in exp and (retryable == "1") != exp["retryable"]:
                    failures.append(f"{sid}: retryable {retryable}")
                if "statusCode" in exp and int(status) != exp["statusCode"]:
                    failures.append(f"{sid}: status {status}")
                if "code" in exp and code != exp["code"]:
                    failures.append(f"{sid}: code {code}")
                if (
                    "messageContains" in exp
                    and exp["messageContains"].lower() not in rest.lower()
                ):
                    failures.append(f"{sid}: message {rest!r}")
            elif "result" in exp:
                d = subset(exp["result"], json.loads(rest))
                if d:
                    failures.append(f"{sid}: result {d}")
            if call["class"] != "ctor":
                with urllib.request.urlopen(f"{url}/_verdict/{sid}") as resp:
                    v = json.load(resp)
                if v["mismatches"]:
                    failures.append(f"{sid}: mismatches {v['mismatches']}")
                if s.get("expectRequest") == [] and v["requests"] != 0:
                    failures.append(f"{sid}: expected no request")
        print(
            f"{binary}: {len(SCEN['scenarios'])} scenarios, {len(failures)} failure(s)"
        )
        for f in failures:
            print("  " + f)
        sys.exit(1 if failures else 0)
    finally:
        proc.kill()
        proc.wait()


if __name__ == "__main__":
    main()
