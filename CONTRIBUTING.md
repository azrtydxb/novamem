# Contributing to novamem

## Development setup

```bash
git clone https://github.com/azrtydxb/novamem
cd novamem
corepack enable && corepack prepare pnpm@9 --activate
pnpm install
pnpm -r build
pnpm test    # 178 tests across server (122) + init (56)
```

For local development against a real Postgres / Qdrant / FalkorDB, the easiest path is `docker compose up -d` from the repo root and then `pnpm --filter @azrtydxb/novamem-server dev`.

## Schema changes

The warm store schema is defined by the migrations in [`go/internal/warmstore/migrations/`](go/internal/warmstore/migrations/), which the server embeds and applies on boot. The SQL is the source of truth; the journal format is drizzle's, so databases migrated by the old TypeScript server continue seamlessly.

**On every schema change**:

1. Write the SQL by hand in a new file: `go/internal/warmstore/migrations/<NNNN>_<name>.sql`, numbered one past the current highest.
2. Split independent statements with `--> statement-breakpoint`, the separator the runner splits on.
3. Register it in `go/internal/warmstore/migrations/meta/_journal.json` with the next `idx` and a `when` timestamp in milliseconds. **The journal order is the apply order**, and `when` is what the runner compares against the database's high-water mark.
4. Commit the SQL and the journal entry **together** — a migration missing from the journal never runs, and a journal entry missing its file fails the build (the files are embedded with `go:embed`).

There is no generator: the schema is the SQL, not a model it is diffed against, so nothing can drift between the two. `go test ./internal/warmstore/` checks that the journal is ordered, that every entry resolves to an embedded file, and that each file's hash still matches the one pinned in `migrations_journal_test.go` — the values live databases already recorded. **Editing an applied migration fails that test on purpose**: a database that applied the old text would never apply the new one, so its schema would silently diverge from the SQL in the tree. Write a new migration instead.

**At runtime**, the server applies migrations on boot:

1. Create the `drizzle` schema and `drizzle.__drizzle_migrations` if absent (a fresh database).
2. Read `max(created_at)` from the journal table — the high-water mark.
3. Refuse to start if the database carries a migration **newer** than anything the binary ships: that schema came from a newer release and may have moved underneath this one.
4. Apply every embedded migration whose `when` is past the high-water mark, in journal order, inside a single transaction, recording each in the journal table.

The first migration (`0000_*.sql`) uses `CREATE TABLE IF NOT EXISTS` everywhere so it's a no-op against databases that pre-date the journal. Subsequent migrations are plain — they apply to a database known to already have the prior schema.

Because the journal format and hashes are drizzle's, a database migrated by the retired TypeScript server continues without any conversion step: the Go runner reads the same table and picks up exactly where drizzle-kit left off.

### Renames and destructive changes

Hand-written SQL removes the generator's guesswork, but the traps remain:

- **Rename column**: `ALTER TABLE … RENAME COLUMN old TO new`, never `DROP` + `ADD` — the latter silently discards the data.
- **Rename table**: `ALTER TABLE … RENAME TO …`, same reason.
- **Type changes** (e.g. text → varchar(255)): may need a `USING` clause, or a staged migration if the table is large enough that a rewrite would lock it too long.

### Data migrations

Schema migrations only handle DDL. For backfills (e.g. populate a new column from existing rows), one-shot transforms, or any operation that touches data:

- Write a one-off Go program under `go/cmd/` (or plain SQL applied out of band)
- Run it manually after deploying the schema change and before the application code that depends on the new shape
- Document it in the relevant changelog entry

novamem doesn't have a registered data-migration runner yet. If we accumulate enough of them, that's worth adding.

### Multi-step rolling deployments

For changes that can't be applied atomically (e.g. add new column, backfill, drop old column), split across releases:

1. Release N: add the new column with a default; deploy code that writes both old and new
2. Release N+1: backfill old rows → new column
3. Release N+2: deploy code that reads only the new column
4. Release N+3: drop the old column

Each release ships a self-contained migration; the application code in each release tolerates both the pre-migration and post-migration schema state.

### Useful commands

| Command                                  | What it does                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `cd go && go test ./internal/warmstore/` | Checks journal order, that every entry resolves to an embedded file, and that no applied migration's hash changed |
| `cd go && go run ./cmd/gen-openapi`      | Regenerates `docs/api/openapi.json` from the server's own route table (CI fails on drift)                         |
| `go/scripts/sync-admin-ui.sh`            | Copies a fresh `packages/admin-ui/dist` into the binary's embedded assets                                         |

Never apply schema changes to a production-grade database by hand or with an
ad-hoc tool: that skips the journal and makes every later migration ambiguous
about what state it is starting from. Migrations are the only path.

## Tests

- `pnpm test` from the repo root runs every package's vitest suite.
- `cd go && go test ./...` runs the server's own suite. The httpapi tests use an in-memory fake store — they don't hit Postgres.
- The contract that matters is `packages/conformance`: a black-box suite run against a live server (`pnpm conformance` with `NOVAMEM_URL` et al.). It is the oracle — behaviour is what it says it is, not what a unit test asserts.

## CI

`.github/workflows/ci.yml` runs on every push to main and on PRs:

- **test (amd64)** + **test (arm64)** on native runners — typecheck, build, vitest
- **go** — `go build`, `go vet`, `go test` for the server and the shared client, golangci-lint for both, plus the OpenAPI drift gate
- **audit** — `pnpm audit --prod --audit-level=high`
- **package (npm)** — `pnpm pack` artefacts uploaded for the three published packages
- **docker (amd64)** + **docker (arm64)** — native build + Trivy HIGH/CRITICAL scan, pushed to ghcr.io on main
- **manifest (multi-arch)** — stitches the per-arch images into `:main` and `:sha-<short>`

## Releases

Driven by [Changesets](https://github.com/changesets/changesets). No token, OIDC publish via npm Trusted Publishers. Each publishable package (`@azrtydxb/novamem`, `@azrtydxb/novamem-mcp`, `@azrtydxb/novamem-init`) versions independently — you only release what changed. See `.github/workflows/release.yml`.

### What you do on a PR

If your PR changes a publishable package, run:

```bash
pnpm changeset
```

Pick the affected packages and the bump kind (`patch` / `minor` / `major`), write a one-line summary. This writes a `.changeset/<random-name>.md` file. **Commit it with the rest of your PR.** Changes that only touch private packages (`@azrtydxb/novamem-server`, `@azrtydxb/novamem-admin-ui`) or non-source paths (docs/CI/tests) don't need a changeset.

### What CI does on merge

When the PR merges to `main`, the release workflow looks for unconsumed `.changeset/*.md` files. Two states:

1. **Pending changesets exist** → workflow opens (or updates) a `chore(release): version packages` PR that bumps every affected `package.json` version, regenerates per-package `CHANGELOG.md`s, and deletes the consumed changeset files. **Review and merge that PR** when ready to ship.
2. **No pending changesets** (i.e. you just merged the version PR) → workflow runs `pnpm changeset publish`, which calls `npm publish` per package and skips versions already on the registry. Provenance attaches via `NPM_CONFIG_PROVENANCE=true` set at the workflow job level (the `--provenance` flag isn't pluggable through the changesets action). Result: only the changed packages publish, each with a Sigstore attestation.

### Notes

- Versions are **independent per package** — bumping `@azrtydxb/novamem` doesn't bump `-mcp` or `-init`.
- Tags become per-package: `@azrtydxb/novamem@1.2.0`, `@azrtydxb/novamem-init@1.1.4`. The legacy mono `vX.Y.Z` tags (v0.1.0 – v1.1.1) stay around but won't be added to.
- npm Trusted Publishers binding requires Node 24 (npm 11+) so OIDC authenticates the publish PUT, not just the Sigstore signing. Don't downgrade `node-version` in `release.yml`.
- `pnpm release:preflight` / `pnpm docs:smoke` still run via CI's `test` job — they're independent of the release flow.

## Per-package source layout

Each package's `src/` follows a flat-by-default convention with folders only when a module genuinely spans multiple files:

- **Go packages**: one directory per bounded concern under `go/internal/`. Examples: `go/internal/engine/`, `go/internal/warmstore/`, `go/internal/httpapi/`. The package owns its private helpers and exports only what other packages consume.
- **TypeScript packages** (`packages/client`, `packages/mcp`, `packages/init`, `packages/admin-ui`): a folder with `index.ts` as the public entry for multi-file modules, or a flat file at the package root when the file IS the module.

When a single-file module grows enough to need internal helpers, promote it to a folder with `index.ts` rather than dropping a `*-helpers.ts` sibling next to it. Mixing the two styles in one package makes import paths inconsistent.

## Code style

- Format: not enforced (no prettier/eslint run on commit; we rely on TS strict + noUncheckedIndexedAccess)
- Imports: group node, then external deps, then `./` relative
- No emojis in code or commit messages unless explicitly requested
- Default to no comments. Add a short one only when WHY is non-obvious — never restate WHAT
