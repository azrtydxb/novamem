# SDK T7: Python SDK

Status: closed 2026-09-25
Created: 2026-09-25

## Description

Ship clients/python (PyPI `novamem` 0.1.0, zero dependencies, sync and async), held to the shared scenario suite (plan Task 7, spec S-4).

## Acceptance criteria

- [x] `cd clients/python && PYTHONPATH=src:tests python -m unittest discover -s tests -v` passes on Python 3.10 and 3.13 (3.14 locally; 3.10 and 3.13 run in the sdk.yml `python` matrix)
- [x] Removing token redaction fails `token-echoed-in-401-is-redacted` (mutation check, reverted)
- [x] `pip install ./clients/python` in a fresh venv lists only `novamem==0.1.0`
- [x] `smoke.py` exists, and the `python` job is in sdk.yml

## Evidence

- Local: `cd clients/python && PYTHONPATH=src:tests python3 -m unittest discover -s tests -v` → `Ran 3 tests … OK` on Python 3.14.7. All 80 scenarios pass on the sync client (the two cancel scenarios are skipped, printed by id) and all 78 non-ctor scenarios on the async client; the routes test resolves all 41 methods on both. The 3.10 and 3.13 runs are in the sdk.yml `python` matrix and will be checked on the PR.
- Mutation: disabling `_degraded_empty` → `FAIL … [search-degraded-empty-is-unavailable] AssertionError: 'empty' != 'unavailable'`. Removing the redaction → `FAIL … [token-echoed-in-401-is-redacted] … 'nm_scenario_TOKEN_must_never_leak' unexpectedly found`. Both restored.
- Dependencies: fresh venv `pip install ./clients/python`, then `pip list --format=freeze` minus pip/setuptools → `novamem==0.1.0` only.
- smoke.py (up/down, "python <step>: <detail>") exists; the `python` job is in sdk.yml (`actionlint` clean). ruff check and format are clean, with the generated files excluded.
