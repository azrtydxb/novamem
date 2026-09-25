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


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "up"
    c = novamem.Client(
        os.environ["NOVAMEM_SMOKE_URL"], os.environ["NOVAMEM_SMOKE_TOKEN"]
    )
    if mode == "down":
        try:
            c.search(novamem.SearchRequest(query="anything"))
        except novamem.UnavailableError:
            print("PASS python down")
            return
        except novamem.NovamemError as e:
            fail("down", f"want UnavailableError, got {e!r}")
        fail("down", "search succeeded against a stopped server")

    marker = uuid.uuid4().hex
    try:
        cap = c.capture(
            novamem.CaptureRequest(
                content=f"sdk-smoke python {marker}", namespace="sdk-smoke", force=True
            )
        )
    except novamem.NovamemError as e:
        fail("capture", repr(e))
    if not cap.id:
        fail("capture", f"not saved: {cap!r}")
    hits = c.search(novamem.SearchRequest(query=marker, namespace="sdk-smoke"))
    if cap.id not in [r.id for r in hits.results]:
        fail("search", f"captured {cap.id} not found in {[r.id for r in hits.results]}")
    gone = c.forget(novamem.ForgetRequest(id=cap.id))
    if not gone.deleted:
        fail("forget", repr(gone))
    after = c.search(novamem.SearchRequest(query=marker, namespace="sdk-smoke"))
    if cap.id in [r.id for r in after.results]:
        fail("search-after-forget", f"{cap.id} still returned")
    print("PASS python up")


if __name__ == "__main__":
    main()
