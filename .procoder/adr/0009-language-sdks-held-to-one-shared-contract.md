# 0009 — Language SDKs held to one shared contract

Status: accepted
Date: 2026-09-25
Supersedes: 0002

## Context

ADR 0002 deprecated the npm TS client and made the HTTP API the only
contract, with clients/go as the one binding. The reason was maintenance:
a binding has to keep surface parity with every API change, and with the
internal consumers gone, nobody was paying that cost.

The owner now wants first-class SDKs for the languages integrators
actually use. Most agent frameworks live in Python and TypeScript
(LangChain, LlamaIndex, CrewAI, Vercel AI SDK, Mastra), and enterprise
integrators live on .NET (Semantic Kernel) and the JVM (Spring AI,
LangChain4j). Telling them to call the HTTP API directly means every
integrator has to rediscover the error contract that clients/go
enforces:

- "nothing stored" and "could not reach the store" are different
  answers,
- `200 {results: [], degraded: true}` is an outage, not an empty result,
- `Capture` is never retried on the caller's behalf,
- 401, 403 and 400 are never retryable,
- the bearer token never appears in an error.

An integrator who gets one of these wrong ships an agent that says "I
have no record of that" while a pod is restarting. What makes a binding
worth having is that contract, not the typed wrappers. And 0002's
objection still holds: N hand-kept bindings drift unless something
mechanical stops them.

## Decision

Ship SDKs for **Python, TypeScript, .NET, Java, Rust, C/C++, Ruby, PHP
and Swift**, all in one push, with Go as the reference implementation.
Each SDK lives in `clients/<lang>`. Parity is enforced mechanically, not
by review:

1. **Types are generated from `api/openapi.yaml`** in each language
   (request and response models only). The generated output is checked
   in and CI diffs it, the same way the served spec is diffed today, so
   a spec change that isn't regenerated fails CI.
2. **Methods and the error contract are hand-written.** The surface is
   small (the Go client covers about a dozen operations), so this layer
   is the part worth writing by hand. Generators cannot express
   "degraded is unavailable".
3. **One shared behaviour suite: `clients/contract/scenarios.json`.**
   Each scenario is a scripted server response (status, body, or a
   transport fault such as a refused dial or a timeout) plus the
   classification the SDK must report: `ok`, `empty`, `unavailable`,
   `retryable`, `not_found` or `error`, and whether the token leaked.
   Every SDK, Go included, runs every scenario in CI.
4. **Route coverage per SDK.** Each SDK carries the equivalent of
   `clients/go/routecoverage_test.go`: every route in the spec is
   either mapped to a method or listed as a non-goal with a reason. A
   new route fails every SDK until each one makes a decision about it.
5. **C/C++ is a C ABI over the Rust SDK**, with a header-only C++
   wrapper on top, rather than a separate native implementation. The
   contract then lives in one fewer place, and C avoids having to choose
   and pin its own HTTP and JSON libraries.

The only ordering constraint is that the Go client moves onto the
scenario suite first, because it proves the suite against the binding
that already behaves correctly. The other SDKs are built in parallel
after that.

Alternatives weighed:

- **Keeping 0002 (HTTP API only).** Rejected. It pushes the error
  contract onto every integrator, which is where it gets lost.
- **Fully generated clients** (openapi-generator, Stainless, Speakeasy).
  Rejected as the whole client. They produce the transport but not the
  contract, and each pulls a different runtime dependency set into its
  language. They are kept for types only (point 1).
- **A native C implementation.** Rejected in favour of point 5. It would
  be a second implementation of the contract in the language where
  getting HTTP, TLS and JSON right costs the most.
- **SDKs over MCP instead of REST.** Out of scope. MCP hosts already
  have official MCP SDKs in these languages; these SDKs serve
  applications that call the REST API.

## Consequences

Easier: integrators in every major ecosystem get the "unavailable is
not empty" guarantee without reading the Go source. The contract
becomes a language-neutral artifact (`scenarios.json`) instead of prose
in one README. An API change surfaces in every SDK's CI at once, not as
silent drift.

Harder: publishing comes back, now on eight channels (PyPI, npm, NuGet,
Maven Central, crates.io, RubyGems, Packagist, and SwiftPM/vcpkg/Conan
via git tags and GitHub releases). This reverses the "npm publishing
ends" consequence of 0001 and 0002 for the SDK only; the shim and
installer stay GitHub-release binaries. Each channel needs its own
credentials, a release workflow, and a tag scheme
(`clients/<lang>/vX.Y.Z`, matching Go's module tags). CI grows nine
toolchains, and the C/C++ SDK's build depends on the Rust one. Every
API change now costs a hand-written method in nine more languages,
which is what 0002 refused to pay; the scenario suite and route pins
keep that cost visible rather than making it go away. Building all nine
at once means the scenario suite has to be stable before the parallel
work starts, or every SDK absorbs its churn. The deprecated npm
client's package name must either be reused for the new TS SDK (with a
major version bump and a notice lifting the deprecation) or left dead
in favour of a new name. That choice is made when the TS SDK is built.
