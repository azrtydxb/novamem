# novamem conformance suite

Black-box contract tests that run against ANY novamem URL. A green run
against the TypeScript server is the oracle baseline for the Go
migration; the Go server is done when the same run is green against it.

## The oracle rule

A red test against the TS server means the TEST is wrong — fix the test,
not the server — unless you can prove a TS bug (then fix the server on
main first, and only then adjust the test). The suite transcribes
behavior; it never defines it.

## Coverage-gate rule

Every new server endpoint must be claimed in `src/coverage.ts` with a
real test backing the claim (spec §7). The meta suite fails on unclaimed
routes in the live OpenAPI document.

Some surfaces are `schema: { hide: true }` and therefore invisible to
that gate — the whole `/api/auth/*` allow-list and the `/admin` SPA
mount. They are claimed in `coverage.ts` anyway: the manifest doubles as
the inventory of what conformance owns, and the parity audit found 22
`/api/auth/*` endpoints missing on the Go server under a fully green run
precisely because nothing listed them.

## Backend neutrality

Nothing here may assume a particular cold-store backend. No assertion
names a provider, a collection, a vector dimension, or a vector count;
`deps.cold` is `ok`/`unreachable` and `totalCold` is only ever compared
against itself. The same run must be green on pgvector and on Qdrant.

## Loud skips

A test that cannot run must SKIP VISIBLY, never pass quietly. Suites
gated on an optional capability register an `it.skip("SKIPPED — …")`
placeholder so the reason shows up in the report. Two gates were
previously silent and are now `hasAdminIdentity` (see `src/env.ts`):
`50-me` and the operator-gated half of `30-ingest` used to skip their
entire lifecycle whenever the run supplied `NOVAMEM_ADMIN_EMAIL` +
`NOVAMEM_ADMIN_PASSWORD` instead of a pre-minted `NOVAMEM_ADMIN_COOKIE`.

## Running

Local (docker compose up/down included):

    ./scripts/conformance-local.sh          # from the repo root

Against novamem-bench (the migration oracle):

    NOVAMEM_URL=http://192.168.10.121:7778 \
    NOVAMEM_ORIGIN=http://novamem-bench.kw.local \
    NOVAMEM_AUTH_MODE=user \
    NOVAMEM_TEST_TOKEN=nm_... \
    NOVAMEM_ADMIN_TOKEN=nm_... \
    NOVAMEM_ADMIN_EMAIL=admin@bench.local \
    NOVAMEM_ADMIN_PASSWORD=... \
    NOVAMEM_ADMIN_DASHBOARD=0 \
    NOVAMEM_LLM_SUBSYSTEMS=1 \
    pnpm conformance

Tokens come from the admin provisioning flow (`POST /v1/admin/users`) or
the dashboard's API Tokens page.

## Env contract

| Var                                              | Required            | Purpose                                                                                                                                                                                            |
| ------------------------------------------------ | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOVAMEM_URL`                                    | yes                 | Target server. Trailing slash tolerated.                                                                                                                                                           |
| `NOVAMEM_AUTH_MODE`                              | default `user`      | Which mode the target runs; gates mode-specific suites.                                                                                                                                            |
| `NOVAMEM_TEST_TOKEN`                             | user/bearer modes   | Data-plane bearer every suite uses.                                                                                                                                                                |
| `NOVAMEM_ADMIN_TOKEN`                            | admin suites        | Admin-owned `nm_` bearer.                                                                                                                                                                          |
| `NOVAMEM_ADMIN_EMAIL` / `NOVAMEM_ADMIN_PASSWORD` | cookie-gated suites | Mints a Better Auth session cookie lazily.                                                                                                                                                         |
| `NOVAMEM_ADMIN_COOKIE`                           | optional            | Pre-minted cookie; wins over email/password.                                                                                                                                                       |
| `NOVAMEM_ORIGIN`                                 | user mode           | Origin for the sign-in call — Better Auth rejects undici's `Origin: null`; must match the server's `NOVAMEM_BASE_URL`.                                                                             |
| `NOVAMEM_CORS_ALLOWED_ORIGIN`                    | optional            | An origin on the target's `NOVAMEM_CORS_ORIGINS` allow-list. Defaults to `http://localhost:5173`, which is `config.ts`'s own default — i.e. what a target that never sets the var actually serves. |
| `NOVAMEM_ADMIN_DASHBOARD`                        | optional            | Mirrors the server's flag so `42-dashboard` asserts the enabled or the disabled contract. Unset ⇒ the suite probes `/admin` once and infers the mode.                                              |
| `NOVAMEM_LLM_SUBSYSTEMS`                         | optional            | Set to `1` when the target runs fact extraction / the observer / query decomposition. Unset ⇒ `90-llm` skips loudly instead of waiting on facts that will never be derived.                        |

`NOVAMEM_TEST_TOKEN` must belong to the **same account** as the admin
identity. `50-me` asserts that the cookie session and the bearer resolve
to one user (set an active project through the cookie, read it back
through the bearer); pairing an unrelated data-plane token with the
admin cookie fails that test for a configuration reason, not a server
one.

## Deliberate non-tests

- **The global rate limiter is never exhausted.** Its window is one
  minute and its bucket is per-IP, so a test that drove a route to 429
  would throttle every later suite in the same run. `43-cors-ratelimit`
  asserts the `x-ratelimit-*` headers and the `/health|/live|/ready`
  exemption instead.
- **Better Auth's own sign-in throttle IS exhausted**, at the very end of
  `41-better-auth`: its window is ~10 seconds, so it is cheap and
  self-healing. `client.ts`'s `signInRaw` waits that window out
  everywhere else.
- **novamem's per-account 5-strike auth limiter (15-minute window) is
  never tripped.** Wrong-credential assertions are made once each,
  against throwaway accounts.
- **`LAST_ADMIN_PROTECTED` is only probed when the target has exactly one
  admin** — the guard only fires when the target _is_ the last admin, and
  on a multi-admin target the same call would really delete an account.

## Regenerating the MCP tools snapshot

The MCP suites pin `reference/tools.snapshot.json` (names AND input
schemas). After a deliberate tool-surface change on main:

    NOVAMEM_URL=... NOVAMEM_TEST_TOKEN=... node scripts/snapshot-tools.mjs

and commit the diff — an unreviewed snapshot diff is the drift alarm.
