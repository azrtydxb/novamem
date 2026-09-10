# novamem conformance suite

Black-box contract tests that run against ANY novamem URL. Ported from
the TypeScript suite (`packages/conformance`, retired 2026-08-20) per
[ADR 0003](../.procoder/adr/0003-port-conformance-suite-to-go.md), case
for case: the last green run of both suites against the same target
matched 98 passed in every suite file.

## The independence rule

The suite's value is that it shares nothing with the implementation it
tests. It is its own Go module, imports **only the standard library**,
and reaches the server **only over HTTP** — no engine types, no shared
helpers, no test fixtures in common. `boundary_test.go` fails the build
the moment that stops being true. Convenience that erodes independence
is not convenience; the parity audit found real divergences precisely
because nothing here could see the server's internals.

## The oracle rule

The suite transcribes behaviour; it never defines it. A red test is
first evidence that the TEST is wrong — fix the test, unless you can
prove a server bug (then fix the server first, and only then adjust the
test).

## Coverage-gate rule

Every new server endpoint must be claimed in `coverage.go` with a real
test backing the claim. `TestEveryLiveEndpointIsClaimedBySuite` fails on
unclaimed routes in the live OpenAPI document.

Some surfaces are hidden from that document — the whole `/api/auth/*`
allow-list and the `/admin` SPA mount. They are claimed in
`coverage.go` anyway: the manifest doubles as the inventory of what
conformance owns, and the parity audit found 22 `/api/auth/*` endpoints
missing on the Go server under a fully green run precisely because
nothing listed them.

## Backend neutrality

Nothing here may assume a particular cold-store backend. No assertion
names a provider, a collection, a vector dimension, or a vector count;
`deps.cold` is `ok`/`unreachable` and `totalCold` is only ever compared
against itself. The same run must be green on pgvector and on Qdrant.

## Loud skips

A test that cannot run must SKIP VISIBLY, never pass quietly. Every gate
is a `t.Skip` carrying its reason, so the reason shows up in the report.
With `NOVAMEM_URL` unset the whole suite skips — which is what makes it
safe to compile, vet, and run in CI without a target.

## Running

Local (docker compose up/down included):

    ./scripts/conformance-local.sh          # from the repo root

Against a live target:

    NOVAMEM_URL=http://192.168.10.121:7778 \
    NOVAMEM_ORIGIN=http://novamem-bench.kw.local \
    NOVAMEM_AUTH_MODE=user \
    NOVAMEM_TEST_TOKEN=nm_... \
    NOVAMEM_ADMIN_TOKEN=nm_... \
    NOVAMEM_ADMIN_EMAIL=admin@bench.local \
    NOVAMEM_ADMIN_PASSWORD=... \
    NOVAMEM_ADMIN_DASHBOARD=0 \
    NOVAMEM_LLM_SUBSYSTEMS=1 \
    pnpm conformance          # or: cd conformance && go test -v ./...

Tokens come from the admin provisioning flow (`POST /v1/admin/users`) or
the dashboard's API Tokens page.

## Env contract

| Var                                              | Required            | Purpose                                                                                                                                                                                           |
| ------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOVAMEM_URL`                                    | yes (else all skip) | Target server. Trailing slash tolerated.                                                                                                                                                          |
| `NOVAMEM_AUTH_MODE`                              | default `user`      | Which mode the target runs; gates mode-specific suites.                                                                                                                                           |
| `NOVAMEM_TEST_TOKEN`                             | user/bearer modes   | Data-plane bearer every suite uses.                                                                                                                                                               |
| `NOVAMEM_ADMIN_TOKEN`                            | admin suites        | Admin-owned `nm_` bearer.                                                                                                                                                                         |
| `NOVAMEM_ADMIN_EMAIL` / `NOVAMEM_ADMIN_PASSWORD` | cookie-gated suites | Mints a Better Auth session cookie lazily.                                                                                                                                                        |
| `NOVAMEM_ADMIN_COOKIE`                           | optional            | Pre-minted cookie; wins over email/password.                                                                                                                                                      |
| `NOVAMEM_ORIGIN`                                 | user mode           | Origin for the sign-in call — Better Auth rejects an `Origin: null`; must match the server's `NOVAMEM_BASE_URL`.                                                                                  |
| `NOVAMEM_CORS_ALLOWED_ORIGIN`                    | optional            | An origin on the target's `NOVAMEM_CORS_ORIGINS` allow-list. Defaults to `http://localhost:5173`, which is the server's own default — i.e. what a target that never sets the var actually serves. |
| `NOVAMEM_ADMIN_DASHBOARD`                        | optional            | Mirrors the server's flag so the dashboard suite asserts the enabled or the disabled contract. Unset ⇒ the suite probes `/admin` once and infers the mode.                                        |
| `NOVAMEM_LLM_SUBSYSTEMS`                         | optional            | Set to `1` when the target runs fact extraction / the observer / query decomposition. Unset ⇒ the LLM suite skips loudly instead of waiting on facts that will never be derived.                  |

## Layout

| File               | What it holds                                                         |
| ------------------ | --------------------------------------------------------------------- |
| `client.go`        | Env contract + HTTP helpers (bearer, cookie, sign-in, throttle waits) |
| `schema.go`        | Shape validator with passthrough semantics (unknown fields always ok) |
| `schemas.go`       | Response shapes every suite asserts against                           |
| `coverage.go`      | Endpoint → owning suite manifest                                      |
| `boundary_test.go` | The independence check                                                |
| `*_test.go`        | One file per retired TS suite, same case names                        |
