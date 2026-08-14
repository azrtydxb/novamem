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
    pnpm conformance

Tokens come from the admin provisioning flow (`POST /v1/admin/users`) or
the dashboard's API Tokens page.

## Env contract

| Var | Required | Purpose |
|-----|----------|---------|
| `NOVAMEM_URL` | yes | Target server. Trailing slash tolerated. |
| `NOVAMEM_AUTH_MODE` | default `user` | Which mode the target runs; gates mode-specific suites. |
| `NOVAMEM_TEST_TOKEN` | user/bearer modes | Data-plane bearer every suite uses. |
| `NOVAMEM_ADMIN_TOKEN` | admin suites | Admin-owned `nm_` bearer. |
| `NOVAMEM_ADMIN_EMAIL` / `NOVAMEM_ADMIN_PASSWORD` | cookie-gated suites | Mints a Better Auth session cookie lazily. |
| `NOVAMEM_ADMIN_COOKIE` | optional | Pre-minted cookie; wins over email/password. |
| `NOVAMEM_ORIGIN` | user mode | Origin for the sign-in call — Better Auth rejects undici's `Origin: null`; must match the server's `NOVAMEM_BASE_URL`. |

## Regenerating the MCP tools snapshot

The MCP suites pin `reference/tools.snapshot.json` (names AND input
schemas). After a deliberate tool-surface change on main:

    NOVAMEM_URL=... NOVAMEM_TEST_TOKEN=... node scripts/snapshot-tools.mjs

and commit the diff — an unreviewed snapshot diff is the drift alarm.
