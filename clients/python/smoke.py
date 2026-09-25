"""Live round trip against a real server, for the sdk-smoke CI job.

    NOVAMEM_SMOKE_URL=… NOVAMEM_SMOKE_TOKEN=… python smoke.py up|down

up:   capture → search finds it → forget deletes it → search no longer finds it.
down: the server has been stopped; search must report UnavailableError, not
      an empty result.
Every failure prints "python <step>: <detail>" and exits 1.
"""

import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

import novamem


def fail(step, detail):
    print(f"python {step}: {detail}")
    sys.exit(1)


def step(name, call):
    """Runs one step; any error becomes "python <name>: <detail>"."""
    try:
        return call()
    except Exception as e:  # noqa: BLE001 — the smoke contract reports every failure by step
        fail(name, repr(e))


def down(c):
    try:
        c.search(novamem.SearchRequest(query="anything"))
    except novamem.UnavailableError:
        print("PASS python down")
        return
    except Exception as e:  # noqa: BLE001
        fail("down", f"want UnavailableError, got {e!r}")
    fail("down", "search succeeded against a stopped server")


def up(c):
    marker = uuid.uuid4().hex
    query = novamem.SearchRequest(query=marker, namespace="sdk-smoke")
    content = f"sdk-smoke python {marker}"
    cap = step(
        "capture",
        lambda: c.capture(
            novamem.CaptureRequest(content=content, namespace="sdk-smoke", force=True)
        ),
    )
    if not cap.id:
        fail("capture", f"not saved: {cap!r}")
    hits = step("search", lambda: c.search(query))
    if cap.id not in [r.id for r in hits.results]:
        fail("search", f"captured {cap.id} not found in {[r.id for r in hits.results]}")
    gone = step("forget", lambda: c.forget(novamem.ForgetRequest(id=cap.id)))
    if not gone.deleted:
        fail("forget", repr(gone))
    after = step("search-after-forget", lambda: c.search(query))
    if cap.id in [r.id for r in after.results]:
        fail("search-after-forget", f"{cap.id} still returned")
    print("PASS python up")


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "up"
    c = step(
        "connect",
        lambda: novamem.Client(
            os.environ["NOVAMEM_SMOKE_URL"], os.environ["NOVAMEM_SMOKE_TOKEN"]
        ),
    )
    down(c) if mode == "down" else up(c)


if __name__ == "__main__":
    main()
