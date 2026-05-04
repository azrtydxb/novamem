/**
 * drizzle-kit config for the warm store.
 *
 * Schema lives in `src/warm-store/schema.ts`; generated migrations go to
 * `src/warm-store/migrations/`. The migration table is the default
 * `drizzle.__drizzle_migrations` (drizzle-kit's convention).
 *
 * Workflow:
 *   - Edit src/warm-store/schema.ts
 *   - `pnpm db:generate` → drizzle-kit diffs and writes a new
 *     migrations/<timestamp>_<animal>.sql
 *   - Commit both schema and migration together
 *   - `pnpm db:check` (run in CI) — fails if schema and migrations drift
 *
 * Migrations apply at runtime via `migrate()` in WarmStore.initialize().
 * For NOVAMEM_WARM_URL-driven generation (introspect / push), set the
 * env var when invoking drizzle-kit.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/warm-store/schema.ts",
  out: "./src/warm-store/migrations",
  // Used by `db:push` and `db:introspect`; harmless when only running
  // `db:generate` (which is the path we actually exercise).
  dbCredentials: {
    url: process.env.NOVAMEM_WARM_URL ?? "postgres://novamem:novamem@localhost:5432/novamem",
  },
  strict: true,
  verbose: true,
});
