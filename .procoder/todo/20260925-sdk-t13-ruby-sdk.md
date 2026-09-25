# SDK T13: Ruby SDK

Status: closed 2026-09-25
Created: 2026-09-25

## Description

Ship clients/ruby (RubyGems `novamem` 0.1.0, stdlib only), held to the shared scenario suite (plan Task 13, spec S-10).

## Acceptance criteria

- [x] `ruby -Ilib -e 'require "novamem"'` succeeds with an empty GEM_HOME
- [x] `cd clients/ruby && rake test` passes on Ruby 3.2 (cancel scenarios skipped with ids; 4.0.6 locally, 3.2 in the sdk.yml `ruby` job)
- [x] Removing the degraded check fails `test_search_degraded_empty_is_unavailable` (mutation check, reverted)
- [x] smoke.rb exists, and the `ruby` job is in sdk.yml

## Evidence

- Local (Ruby 4.0.6): `cd clients/ruby && rake test` (warnings on) → `89 runs, 416 assertions, 0 failures, 0 errors, 2 skips`, with the two cancel scenarios skipped with their ids. Also: routes (41 methods), redirect (cross-origin drop, other port, same-origin keep), and wire (required null, optional omission, timestamps, per-type FIELDS).
- No gems: `GEM_HOME=<empty> ruby -Ilib -e 'require "novamem"'` → loads; `gem build` succeeds with no add_dependency.
- Mutation: disabling degraded_empty! → `test_search_degraded_empty_is_unavailable` fails. Removing the redaction → `test_token_echoed_in_401_is_redacted` fails. Keeping auth across origins → `the bearer followed a redirect to another origin`. All restored.
- smoke.rb against a dead port: `PASS ruby down`, and `up` → `ruby capture: … ECONNREFUSED` with exit 1. The sdk.yml `ruby` job exists; the gate is clean (0 unformatted).
