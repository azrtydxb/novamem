"""The shared behaviour suite (clients/contract/scenarios.json, ADR 0009),
run against both the sync and the async client."""

import asyncio
import json
import subprocess
import unittest
import urllib.request
from pathlib import Path

from _dispatch import ADISPATCH, DISPATCH

import novamem

CONTRACT = Path(__file__).resolve().parents[2] / "contract"
SCEN = json.loads((CONTRACT / "scenarios.json").read_text())
TOKEN = SCEN["token"]
CANCELED = object()  # the outcome of an awaited call whose task was cancelled


def is_empty(result):
    wire = result.to_wire() if hasattr(result, "to_wire") else result
    return wire == [] or (isinstance(wire, dict) and wire.get("results") == [])


def classify(result, err):
    if err is CANCELED:
        return "canceled"
    if err is None:
        return "empty" if is_empty(result) else "ok"
    if isinstance(err, novamem.UnavailableError):
        return "unavailable"
    if isinstance(err, novamem.NotFoundError):
        return "not_found"
    return "error"


def subset(want, got, path="$"):
    """The first place want is not contained in got, or ""."""
    if isinstance(want, dict):
        if not isinstance(got, dict):
            return f"{path}: want an object, got {got!r}"
        for k, v in want.items():
            d = subset(v, got.get(k), f"{path}.{k}")
            if d:
                return d
        return ""
    return "" if want == got else f"{path}: got {got!r}, want {want!r}"


class Scenarios(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.proc = subprocess.Popen(
            ["sh", "scenario-server.sh", "-scenarios", "scenarios.json"],
            cwd=CONTRACT,
            stdout=subprocess.PIPE,
            text=True,
        )
        _, cls.url, closed = cls.proc.stdout.readline().split()
        cls.closed = closed.split("=")[1]

    @classmethod
    def tearDownClass(cls):
        cls.proc.kill()
        cls.proc.wait()

    def base(self, s):
        if '"refused"' in json.dumps(s.get("respond")):
            return f"http://127.0.0.1:{self.closed}/s/{s['id']}"
        return f"{self.url}/s/{s['id']}"

    def check(self, s, result, err):
        exp = s["expect"]
        self.assertEqual(classify(result, err), exp["outcome"], f"{s['id']}: {err!r}")
        if isinstance(err, novamem.NovamemError):
            self.assertNotIn(TOKEN, str(err), s["id"])
            self.assertNotIn(TOKEN, repr(err), s["id"])
            if "retryable" in exp:
                self.assertEqual(err.retryable, exp["retryable"], s["id"])
            if "statusCode" in exp:
                self.assertEqual(err.status_code, exp["statusCode"], s["id"])
            if "code" in exp:
                self.assertEqual(err.code, exp["code"], s["id"])
        if isinstance(err, Exception) and "messageContains" in exp:
            self.assertIn(exp["messageContains"].lower(), str(err).lower(), s["id"])
        if "result" in exp:
            got = result.to_wire() if hasattr(result, "to_wire") else result
            self.assertEqual(subset(exp["result"], got), "", s["id"])
        if s["call"]["class"] != "ctor":
            with urllib.request.urlopen(f"{self.url}/_verdict/{s['id']}") as r:
                v = json.load(r)
            self.assertEqual(v["mismatches"], [], s["id"])
            if s.get("expectRequest") == []:
                self.assertEqual(v["requests"], 0, s["id"])

    def construct(self, s):
        a = s["call"]["args"]
        try:
            novamem.Client(a["baseUrl"].replace("<server>", self.url), a["token"])
        except novamem.ConfigError as e:
            return None, e
        return None, None

    def run_sync(self, s):
        call = s["call"]
        kw = {"timeout": SCEN["timeoutMs"] / 1000}
        base = self.base(s)
        clients = {
            k: getattr(novamem, k)(base, TOKEN, **kw)
            for k in ("Client", "Management", "Admin")
        }
        try:
            return DISPATCH[call["method"]](clients, call["args"]), None
        except novamem.NovamemError as e:
            return None, e

    def run_async(self, s):
        call = s["call"]
        kw = {"timeout": SCEN["timeoutMs"] / 1000}
        base = self.base(s)

        async def go():
            clients = {
                k: getattr(novamem, "Async" + k)(base, TOKEN, **kw)
                for k in ("Client", "Management", "Admin")
            }
            task = asyncio.ensure_future(
                ADISPATCH[call["method"]](clients, call["args"])
            )
            if call.get("cancelAfterMs"):
                asyncio.get_running_loop().call_later(
                    call["cancelAfterMs"] / 1000, task.cancel
                )
            try:
                return await task, None
            except asyncio.CancelledError:
                return None, CANCELED
            except novamem.NovamemError as e:
                return None, e

        return asyncio.run(go())

    # proved by: removing the degraded-empty check in Client.search fails
    # search-degraded-empty-is-unavailable; removing the token redaction
    # fails token-echoed-in-401-is-redacted.
    def test_sync(self):
        for s in SCEN["scenarios"]:
            if "cancel" in s.get("requires", []):
                print(f"skip (the sync client has no cancellation): {s['id']}")
                continue
            with self.subTest(s["id"]):
                self.check(
                    s,
                    *(
                        self.construct(s)
                        if s["call"]["class"] == "ctor"
                        else self.run_sync(s)
                    ),
                )

    def test_async(self):
        for s in SCEN["scenarios"]:
            if s["call"]["class"] == "ctor":
                continue
            with self.subTest(s["id"]):
                self.check(s, *self.run_async(s))


if __name__ == "__main__":
    unittest.main()
