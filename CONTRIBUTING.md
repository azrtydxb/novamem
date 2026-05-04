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

The warm store schema lives in [`packages/server/src/warm-store/schema.ts`](packages/server/src/warm-store/schema.ts). Drizzle ORM is the source of truth; migrations are generated, versioned, and committed alongside the code change.

**On every schema change**:

1. Edit `schema.ts`
2. `pnpm --filter @azrtydxb/novamem-server db:generate`
   - Runs `drizzle-kit generate`
   - Writes a new file under `packages/server/src/warm-store/migrations/<timestamp>_<name>.sql`
   - Updates `migrations/meta/_journal.json`
3. **Review the generated SQL**. Drizzle's diff is usually right but not always — particularly for column renames (it may emit DROP + ADD instead of ALTER … RENAME COLUMN, which loses data). For destructive or rename operations, hand-edit the migration file.
4. Commit `schema.ts` and the new migration **together** in one commit.
5. CI runs `pnpm db:check` to catch schema/migration drift; the build fails if you forgot step 2.

**At runtime**, the server's `WarmStore.initialize()` (called from `main.ts` on boot) runs:

1. Legacy cleanups (idempotent — drops pre-Better-Auth FKs and the retired `users` / `sessions` tables)
2. Better Auth + Postgres-FTS scaffolding (CREATE TABLE IF NOT EXISTS for the `"user"` / `"session"` / `"account"` / `"verification"` / `"jwks"` tables Better Auth owns)
3. `drizzle-orm/migrator.migrate()` — applies anything new from `dist/warm-store/migrations/` since the last run, tracked in the `__drizzle_migrations` table
4. The `tsv tsvector GENERATED ALWAYS AS (...)` column on `memory_fts` + its GIN index (drizzle's schema DSL doesn't support GENERATED columns, so we add it post-migration)

The first migration (`0000_*.sql`) uses `CREATE TABLE IF NOT EXISTS` everywhere so it's a no-op on databases that pre-date drizzle-kit. Subsequent migrations are plain — they apply to a database that's known to already have the prior schema.

### Renames and destructive changes

drizzle-kit doesn't always detect renames correctly:

- **Rename column**: drizzle may emit `DROP COLUMN old; ADD COLUMN new`. Hand-edit to `ALTER TABLE … RENAME COLUMN old TO new` to preserve data.
- **Rename table**: same. Hand-edit to `ALTER TABLE … RENAME TO …`.
- **Type changes** (e.g. text → varchar(255)): review carefully. May need `USING` clause or staged migration.

When in doubt: write the SQL by hand in the generated migration file. drizzle-kit will use it as-is.

### Data migrations

Schema migrations only handle DDL. For backfills (e.g. populate a new column from existing rows), one-shot transforms, or any operation that touches data:

- Write a one-off TypeScript script under `packages/server/scripts/data-migrations/<timestamp>_<name>.ts`
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

| Command | What it does |
|---|---|
| `pnpm db:generate` | Diff schema.ts vs. the last snapshot; emit a new migration |
| `pnpm db:check` | Validate that schema.ts and migrations/ are in sync (CI runs this) |
| `pnpm db:introspect` | Reverse: read an existing DB and emit drizzle types from it (rarely used; only if you need to onboard an existing un-managed schema) |

`pnpm db:push` exists in drizzle-kit (apply schema directly without migration files) but **don't use it on production-grade databases** — it skips the migration history and makes future schema changes ambiguous. Migrations are the only path.

## Tests

- `pnpm test` from the repo root runs every package's vitest suite.
- The server's unit tests use `FakeWarmStore` (in-memory) — they don't exercise `migrate()` or hit Postgres. The init package's tests use temp dirs and mock fetch.
- For integration tests that hit a real database stack: `pnpm --filter @azrtydxb/novamem-server test:integration`. Requires `docker compose up -d` first (uses NOVAMEM_INTEGRATION=1 to gate them in).

## CI

`.github/workflows/ci.yml` runs on every push to main and on PRs:

- **test (amd64)** + **test (arm64)** on native runners — typecheck, build, vitest, db:check
- **audit** — `pnpm audit --prod --audit-level=high`
- **package (npm)** — `pnpm pack` artefacts uploaded for the three published packages
- **docker (amd64)** + **docker (arm64)** — native build + Trivy HIGH/CRITICAL scan, pushed to ghcr.io on main
- **manifest (multi-arch)** — stitches the per-arch images into `:main` and `:sha-<short>`

## Releases

Tag-driven, no token, OIDC publish via npm Trusted Publishers. See `.github/workflows/release.yml`.

To cut a release:

1. Bump version: edit `version` in the three publishable `package.json` files (`packages/client`, `packages/mcp`, `packages/init`) — keep them aligned.
2. Update `CHANGELOG.md`: convert `[Unreleased]` → `[X.Y.Z] - YYYY-MM-DD` with the day's date, add a fresh `[Unreleased]` heading on top.
3. Commit the bump.
4. `git tag vX.Y.Z && git push --tags`
5. CI publishes all three packages to npm with provenance attestations and creates a GitHub release.

Re-run with `--dry-run: true` via Actions → Release → Run workflow if you want to preview.

## Per-package source layout

Each package's `src/` follows a flat-by-default convention with folders only when a module genuinely spans multiple files:

- **Multi-file modules**: a folder with `index.ts` as the public entry. Examples: `packages/server/src/engine/`, `packages/server/src/warm-store/`. The folder owns its private helpers and a single `index.ts` re-exports the surface other modules consume.
- **Single-file modules**: a flat sibling file at the package root. Examples: `packages/server/src/cold-store.ts`, `packages/server/src/graph-store.ts`, `packages/server/src/embeddings.ts`. No wrapper folder — the file IS the module.

When a single-file module grows enough to need internal helpers, promote it to a folder with `index.ts` rather than dropping a `*-helpers.ts` sibling next to it. Mixing the two styles in one package makes import paths inconsistent.

## Code style

- Format: not enforced (no prettier/eslint run on commit; we rely on TS strict + noUncheckedIndexedAccess)
- Imports: group node, then external deps, then `./` relative
- No emojis in code or commit messages unless explicitly requested
- Default to no comments. Add a short one only when WHY is non-obvious — never restate WHAT
