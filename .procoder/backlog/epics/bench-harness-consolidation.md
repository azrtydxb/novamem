# Benchmark harness consolidation

Status: open
Created: 2026-08-20
Milestone: full-ts-to-go--everything-but-the-web-ui

## Description

Two harnesses exist: packages/benchmarks (~1,900 LOC TS, drives the
recall-eval fixtures and bench:smoke) and bench/ (Python, LongMemEval /
LoCoMo / retrieval). The migration goal says no TS runtime; the epic
decides the target (Go, or consolidate on the Python harness) and
executes it without losing the published benchmark numbers'
reproducibility.
