# SDK T18: documentation

Status: closed 2026-09-25
Created: 2026-09-25

## Description

Write a README for each of the nine SDKs, a docs-site SDKs page and the root README SDK table, with quickstarts compiled in CI and operations tables checked against routes.json (plan Task 18, spec S-15).

## Acceptance criteria

- [x] `sh scripts/check-sdk-readmes.sh` exits 0
- [x] Deleting the `search` row from clients/python/README.md fails the script (mutation check, reverted)
- [x] `cd packages/docs-site && pnpm build` passes with the SDKs page in the sidebar
- [x] The root README.md has the SDK table, and the `readmes` job is in sdk.yml

## Evidence

- Local, every toolchain: `sh scripts/check-sdk-readmes.sh` → `tables: all 41 methods in every README`, then `readme <lang>: quickstart ok` for all nine. Each check-readme.sh was also falsified: python (syntax error), typescript (`c.serch` → TS2551; `k: "5"` → TS2322, so it type-checks against the real types), dotnet (CS1061), java (javac cannot find symbol), rust (E0599, and examples/readme.rs removed on failure), c and c++ (misspelled function), ruby and php (syntax), swift (parse error).
- Mutation: removing the `search` row from clients/python/README.md → `python: operations table has no row for search`, exit 1; restored.
- `pnpm build` in packages/docs-site: `build complete`, site/docs/sdks.html written; the page is docs/sdks.md (the site's srcDir is docs/) under a new "SDKs" sidebar group.
- The READMEs were drafted from each SDK's source (not from the plan), and the drafting surfaced differences between SDKs, recorded below rather than papered over in the docs.

## Follow-ups noted

Cross-SDK consistency, each a contract question for a later change (the READMEs document today's behaviour truthfully):

- Timeout scope: TypeScript, Java, .NET, Swift, Rust and C bound the whole call; Python and Ruby bound the connect and each read, so a trickling server can hold a call past the timeout.
- `changes(since)`: TypeScript, Ruby, Swift, .NET and Java send it as UTC; Python, Rust and C (like Go) pass the string through.
- A token pasted into the base URL is redacted from `toString()` in .NET and Java (#316, #317 reviews); the other SDKs have not been checked for it.
- Cross-origin 307/308 forward the body (with the bearer dropped) in every SDK, as Go does; refusing body-bearing cross-origin redirects would be a contract change plus a scenario (#314 review).
- C: the header exports `*_free` for request and array-item types, which are unsafe on caller-built structs; unknown enum strings and unparseable metadata JSON are dropped rather than rejected.
- Counts typed `number` in the spec (DecayResult, SessionRecapResult.saved, …) generate as floats (from T6).
