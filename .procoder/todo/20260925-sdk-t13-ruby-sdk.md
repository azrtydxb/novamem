# SDK T13: Ruby SDK

Status: open
Created: 2026-09-25

## Description

Ship clients/ruby (RubyGems `novamem` 0.1.0, stdlib only), held to the shared scenario suite (plan Task 13, spec S-10).

## Acceptance criteria

- [ ] `ruby -Ilib -e 'require "novamem"'` succeeds with an empty GEM_HOME
- [ ] `cd clients/ruby && rake test` passes on Ruby 3.2 (cancel scenarios skipped with ids)
- [ ] Removing the degraded check fails `test_search_degraded_empty_is_unavailable` (mutation check, reverted)
- [ ] smoke.rb exists, and the `ruby` job is in sdk.yml

## Evidence
