# SDK T7: Python SDK

Status: open
Created: 2026-09-25

## Description

Ship clients/python (PyPI `novamem` 0.1.0, zero dependencies, sync and async), held to the shared scenario suite (plan Task 7, spec S-4).

## Acceptance criteria

- [ ] `cd clients/python && PYTHONPATH=src:tests python -m unittest discover -s tests -v` passes on Python 3.10 and 3.13
- [ ] Removing token redaction fails `token-echoed-in-401-is-redacted` (mutation check, reverted)
- [ ] `pip install ./clients/python` in a fresh venv lists only `novamem==0.1.0`
- [ ] `smoke.py` exists, and the `python` job is in sdk.yml

## Evidence
