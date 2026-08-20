# The conformance oracle speaks Go

Status: active
Created: 2026-08-20

## Goal

The black-box oracle is a standalone Go module with case parity against
the TS suite (declared and mode-skipped counts match), its independence
enforced by a compile-time boundary check instead of a language gap, a
green run against a live server, and packages/conformance deleted. The
three .mjs repo scripts get their written disposition on the way.
