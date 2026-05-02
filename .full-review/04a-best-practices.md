# Best Practices & Standards Review — novamem

**Stack reviewed**: Node 20+, TypeScript 5.9, Fastify 5, Drizzle 0.36 + raw `pg`, Zod 3.25, bcryptjs 2.4, React 18.3, Vite 6, Tailwind 3.4.

This review focuses on idiomatic use of each tool. Bugs and security issues live in `01a/02a/02b`; here we look at *fit and finish*.

## Summary

| # | Severity | Area | Finding |
|---|---|---|---|
| 1 | High | Fastify | Routes hand-validate inside handlers; `schema:` and `setErrorHandler` are unused — Zod errors leak as 500s |
| 2 | High | React | No data-fetching library; every page hand-rolls `fetch` + `setInterval` polling |
| 3 | High | Vite | recharts (~330KB gz) ships in main bundle; MetricsPage isn't lazy-loaded |
| 4 | High | Zod | Schemas live server-side only; client package re-types every request/response by hand |
| 5 | Medium | Logging | `console.log/warn/error` used in main.ts and main.ts onwards; should use `app.log` / pino |
| 6 | Medium | Drizzle | Mixed Drizzle + raw `pg` (37 raw queries vs 3 ORM calls) with no migration tooling — schema drift is hand-managed |
| 7 | Medium | MCP SDK | `packages/server/src/mcp.ts` and `packages/mcp/src/index.ts` duplicate ~90% of the tool registry |
| 8 | Medium | Deps | Drizzle (0.36 → 0.45), Zod (3 → 4), Vite (6 → 8), React (18 → 19), Tailwind (3 → 4), recharts (2 → 3) all behind majors |
| 9 | Medium | Tailwind | Tailwind v3 JS-config approach; v4 (CSS-native `@theme`) released March 2025 |
| 10 | Medium | React | No router — deep-linking impossible; all tab state lives in `App.tsx` |
| 11 | Low | TS / Fastify | `app.log?.warn?.()` optional-chains a known-defined property; reflects unfamiliarity with the type |
| 12 | Low | TS | Five `r.rows[0]!.created_at` non-null assertions in warm-store right after row-count checks — narrow with a destructure |
| 13 | Low | A11y | Toast container lacks `role="status"` / `aria-live="polite"` |
| 14 | Low | A11y | No skip-link in AppShell; tab change moves visual focus but not programmatic focus |
| 15 | Low | Bcrypt | `bcryptjs` is in maintenance mode (latest is 3.0; project on 2.4); argon2id is the modern default |
| 16 | Low | React | No `react-hook-form`; controlled inputs + manual `onSubmit`. Acceptable for current scope |
| 17 | Low | Build | Vite default chunking only; no `manualChunks` config — the 500KB warning will start firing |
| 18 | Info | TS config | `tsconfig.base.json` is excellent (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, NodeNext) |
| 19 | Info | Module hygiene | ESM with `.js` import suffixes throughout — correct for tsc-only ESM output |
| 20 | Info | StrictMode | `<StrictMode>` enabled in `main.tsx` — kept for the React 19 migration |

---

## 1. Hand-rolled Zod parsing inside handlers, no `setErrorHandler`

**Severity**: High
**Files**: `packages/server/src/http.ts:451-700` (every route)

**Pattern.** Routes call `Body.parse(req.body)` synchronously. There is no `app.setErrorHandler()`, so a malformed payload produces a `ZodError` that Fastify's default handler logs and returns as `500 Internal Server Error`. Validation errors should be 400s with field paths.

```ts
app.post("/v1/search", async (req, reply) => {
  const body = SearchBody.parse(req.body);   // throws on invalid → 500
  ...
});
```

**Recommended.** Either install `fastify-type-provider-zod` to declare schemas in the route option (gives you `request.body` typed and auto-validation, and the error becomes a 400), or add a `setErrorHandler` that catches `ZodError`:

```ts
import { ZodError } from "zod";
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: "validation_failed", issues: err.issues });
  }
  reply.send(err); // delegate to default
});
```

Bonus: with the type provider, the OpenAPI doc derives from your Zod schemas instead of being hand-written in `openapi.ts` (~510 LOC of upkeep).

## 2. No data-fetching library — `useEffect` + `setInterval` per page

**Severity**: High
**Files**: `packages/admin-ui/src/pages/HealthPage.tsx`, `MetricsPage.tsx`, `TenantsPage.tsx`, `UsersPage.tsx`, `MyTokensPage.tsx`, `ProjectsPage.tsx`

Every page reimplements the same pattern: `loading/error/data` triple, manual `setInterval` with cleanup, no request dedup, no stale-while-revalidate, no retry. Switching tabs re-fetches from scratch every time.

```ts
// HealthPage.tsx — repeated in 5 other pages with minor variations
const [data, setData] = useState<HealthSnapshot | null>(null);
useEffect(() => {
  let cancelled = false;
  const load = async () => { /* fetch + setData if !cancelled */ };
  load();
  const id = window.setInterval(load, POLL_MS);
  return () => { cancelled = true; clearInterval(id); };
}, []);
```

**Recommended.** Add `@tanstack/react-query` (~13KB gz) — it gives you polling (`refetchInterval`), cache, dedup, and `isLoading/error` for free, and removes ~100 lines of boilerplate per page.

```ts
const { data, error } = useQuery({
  queryKey: ["health"],
  queryFn: () => apiFn<HealthSnapshot>("GET", "/health"),
  refetchInterval: 5000,
});
```

## 3. recharts is in the main bundle on every page

**Severity**: High
**Files**: `packages/admin-ui/src/App.tsx:7`, `packages/admin-ui/src/pages/MetricsPage.tsx:1-11`

`MetricsPage` is imported eagerly at the top of `App.tsx`. recharts pulls in d3-shape, d3-scale, d3-array, etc. Users hitting `/admin` to log in pay for charts they may never see. Vite already warns about chunks >500KB; this will cross that threshold.

**Recommended.**

```ts
const MetricsPage = lazy(() => import("./pages/MetricsPage").then(m => ({ default: m.MetricsPage })));
// then wrap render with <Suspense fallback={<Spinner />}>...</Suspense>
```

And in `vite.config.ts`, split heavy vendor chunks:

```ts
build: {
  rollupOptions: {
    output: {
      manualChunks: { recharts: ["recharts"], react: ["react", "react-dom"] },
    },
  },
},
```

## 4. Zod schemas not exported to the client

**Severity**: High
**Files**: `packages/server/src/http.ts:59-171` (request shapes), `packages/client/src/index.ts` (300 lines of hand-written types)

Each request body has a Zod schema in http.ts. The `@azrty/novamem` client re-declares the same shapes by hand (`SearchRequest`, `RememberRequest`, etc.), creating two sources of truth. Adding a new field requires two edits and there's no compiler check that they agree.

**Recommended.** Move schemas to `packages/server/src/api-schemas.ts`, export, and have the client `import type { z } from "zod"; export type SearchRequest = z.infer<typeof SearchBody>;`. Or carve a `@azrty/novamem-schemas` package the server *and* client both depend on.

## 5. `console.*` instead of Fastify's pino logger

**Severity**: Medium
**Files**: `packages/server/src/main.ts:24,32,48,49,129,133,148,163`

Fastify ships with pino and exposes it as `app.log` / `request.log`. The codebase imports nothing yet logs via `console.log`/`console.warn`. Result: lifecycle messages don't carry the same structure or level the request log lines do; hard to correlate.

```ts
// main.ts
console.log(`[novamem] reaped orphans:`, reap);
console.error("decay/reap loop error", err);
```

**Recommended.**

```ts
app.log.info({ reap }, "reaped orphans");
app.log.error({ err }, "decay loop error");
```

## 6. Drizzle + raw pg, with no migration tooling

**Severity**: Medium
**Files**: `packages/server/src/warm-store/index.ts` (37 `pool.query` calls vs 3 `db.insert/select`), `packages/server/src/warm-store/schema.ts`

Drizzle is loaded but only used for `db.insert(schema.memoryEntries).values(...)` in three places; everything else is parameterised raw SQL. Schema is created via inline `CREATE TABLE IF NOT EXISTS` strings — there's no `drizzle/` migrations folder and no `drizzle-kit` script in `packages/server/package.json`. This works today but means:

- Drizzle's type-checking (`schema.ts` ↔ DB) buys nothing — schema drift won't be caught.
- `drizzle-kit generate` / `migrate` would let you do additive changes (renames, defaults, indexes) safely; today you have to write idempotent DDL by hand.

**Recommended (one of):**

1. Commit to raw `pg`: drop the `drizzle-orm` dep + schema.ts and just keep the SQL. Honest.
2. Commit to Drizzle: add `drizzle-kit` (devDep), write a `drizzle.config.ts`, generate migrations, and move the inline DDL into a baseline migration. Then the rest of the code can use `db.*` for type-checked queries.

## 7. MCP server tool definitions are duplicated

**Severity**: Medium
**Files**: `packages/server/src/mcp.ts:43-260`, `packages/mcp/src/index.ts:26-220`

Both files build a `Server` and call `setRequestHandler(ListToolsRequestSchema, ...)` + `setRequestHandler(CallToolRequestSchema, ...)`. The tool *list* (names, JSON-schema input shapes, descriptions) is virtually identical — only the dispatch differs (in-process engine call vs HTTP fetch to the remote server).

**Recommended.** Export a shared `tools` array from `packages/server/src/mcp/tools.ts` (the schemas) and let each handler bind a different executor:

```ts
// shared
export const TOOLS = [{ name: "search", description: "...", inputSchema: {...} }, ...];
export type ToolName = typeof TOOLS[number]["name"];
// server (in-process)
register(TOOLS, async (name, args) => engine.dispatch(name, args));
// mcp shim (remote)
register(TOOLS, async (name, args) => fetch(`${baseUrl}/v1/${name}`, {...}));
```

## 8. Major versions behind on six client deps and three server deps

**Severity**: Medium

Per-package `pnpm outdated`:

| Pkg | Current | Latest | Notes |
|---|---|---|---|
| `drizzle-orm` | 0.36.4 | 0.45.2 | API stable across this range; schema-builder additions |
| `zod` | 3.25 | 4.4 | v4 has breaking error-format changes — coordinate with `setErrorHandler` change |
| `@fastify/cors` | 10.1 | 11.2 | follows Fastify 5; check changelog |
| `@fastify/static` | 8.3 | 9.1 | minor API tweaks |
| `bcryptjs` | 2.4 | 3.0 | drops Node <14, type changes |
| `vite` | 6.4 | 8.0 | two majors behind; node 20+ stays supported in v7 |
| `react` / `react-dom` | 18.3 | 19.2 | new ref-as-prop API, removes `forwardRef` need; `<StrictMode>` already in place |
| `recharts` | 2.15 | 3.8 | full rewrite; review migration guide |
| `tailwindcss` | 3.4 | 4.2 | see #9 |
| `lucide-react` | 0.468 | 1.14 | tree-shaking improvements |
| `@types/react` | 18 | 19 | match the runtime version when you upgrade React |
| `vitest` | 2.1 | 4.1 | two majors; mostly tooling |
| `typescript` | 5.9 | 6.0 | minor for most projects |

**Recommended.** Stage upgrades by surface area: (a) Fastify ecosystem and Zod 4 together, (b) React 19 + `@types/react` 19 + Vite + recharts together, (c) Tailwind 4 separately (config rewrite). Drizzle is safe to bump now.

## 9. Tailwind v3 JS-config; v4 released March 2025

**Severity**: Medium
**Files**: `packages/admin-ui/tailwind.config.js`, `packages/admin-ui/postcss.config.*`

The well-curated semantic tokens (bg, panel, border, text, accent…) sit in `tailwind.config.js`. Tailwind v4 deletes that JS config in favour of CSS-native `@theme` blocks and uses Lightning CSS instead of PostCSS, halving build times.

**Migration sketch** (when ready):

```css
/* index.css */
@import "tailwindcss";

@theme {
  --color-bg: #0b0d12;
  --color-bg-panel: #11141b;
  --color-accent: #7c9cff;
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --radius-md: 6px;
  ...
}
```

Not urgent; v3 receives security backports. Worth scheduling for the React 19 sweep so all front-end churn lands in one PR.

## 10. No router — deep-linking impossible

**Severity**: Medium
**Files**: `packages/admin-ui/src/App.tsx:27-55`

```ts
const [tab, setTab] = useState<Tab>(defaultTab);
return <AppShell active={tab} onChange={setTab}>{tab === "metrics" && <MetricsPage />}</AppShell>;
```

The active tab is in-memory only. You can't:
- bookmark `/admin/users`,
- share a link to a specific tenant or project page,
- use browser back/forward to navigate within the dashboard,
- or use middleware-style auth gating per-route.

**Recommended.** `react-router` v6 (or v7) is ~12KB gz. The migration is mechanical — wrap App with `<BrowserRouter basename="/admin">`, replace the conditional render with `<Routes>`, and use `<NavLink>` in `AppShell`. Future "edit tenant X" deep links become trivial.

## 11. Defensive optional chaining on always-defined `app.log`

**Severity**: Low
**Files**: `packages/server/src/http.ts:371`

```ts
app.log?.warn?.("…");
```

`app.log` is always defined on a Fastify instance; `app.log.warn` is a function. The `?.` chains read like nervous code from a TS-newcomer; remove them or replace with `request.log` inside route handlers.

## 12. Non-null assertions on `r.rows[0]` after no length check

**Severity**: Low
**Files**: `packages/server/src/warm-store/index.ts:238,352,417,590`

```ts
return { ..., createdAt: r.rows[0]!.created_at };
```

Five spots use `!` directly on `rows[0]`. With `noUncheckedIndexedAccess` on, this is what the compiler needs — but `!` is still a type-system lie. Some are after `INSERT … RETURNING` (always one row), so it's safe; others are after `SELECT` and could legitimately be empty. Prefer destructuring with a clear failure mode:

```ts
const [row] = r.rows;
if (!row) throw new Error("expected row from RETURNING clause");
return { ..., createdAt: row.created_at };
```

(The throw is dead code under correct DB behaviour, but it documents the assumption and removes the `!`.)

## 13. Toast lacks `role="status"` / `aria-live`

**Severity**: Low
**Files**: `packages/admin-ui/src/components/Toast.tsx`

Inline `aria-label` exists on the dismiss button, but the toast container itself is a plain `<div>`. Screen readers won't announce a "saved" or "deleted" toast.

```tsx
<div role="status" aria-live="polite" aria-atomic="true">
  {message}
</div>
```

For destructive errors use `role="alert"` (or `aria-live="assertive"`).

## 14. No skip-link; tab change does not move focus

**Severity**: Low
**Files**: `packages/admin-ui/src/components/AppShell.tsx`, `App.tsx:27`

When a keyboard user changes tabs, focus stays on the nav item; the rendered page should also receive a focus ring so screen readers announce the new heading. Add `<a href="#main" className="sr-only focus:not-sr-only">Skip to content</a>` and an `id="main" tabIndex={-1}` on the page wrapper that's `.focus()`'d on tab change.

## 15. `bcryptjs` 2.4 — unmaintained, behind 3.x

**Severity**: Low
**Files**: `packages/server/src/auth.ts`, `packages/server/package.json`

`bcryptjs` 2.4 is from 2017. The project still works but the README declares it deprecated in favour of community forks; latest `bcryptjs` is 3.0. argon2id is the modern recommendation (OWASP password storage cheat sheet, 2024 update). `argon2` is a native module so brings the same Alpine-build pain that pushed you to bcryptjs in the first place — `@node-rs/argon2` gives you argon2id with prebuilt binaries for musl/glibc x64 + arm64.

**Order of operations**:

1. Bump to `bcryptjs@3.0.3` now (drop-in, types-only changes).
2. When ready to migrate hashes, lazy-rehash on next successful login (read old `$2a$` → verify with bcrypt → re-hash with argon2id → update row). No mass migration needed.

## 16. Hand-rolled forms

**Severity**: Low
**Files**: `packages/admin-ui/src/pages/SignIn.tsx`, `TenantsPage.tsx`, `UsersPage.tsx`, `ProjectsPage.tsx`

Controlled inputs + `onSubmit`. Fine for the current scale (4-field admin forms). Note for the future: once forms grow past ~6 fields with cross-field validation, `react-hook-form` + `@hookform/resolvers/zod` (with the schemas you'd export per #4) reduces this to one-liners.

## 17. No `manualChunks` in Vite

**Severity**: Low
**Files**: `packages/admin-ui/vite.config.ts`

Vite's default chunking puts everything not dynamically imported into one chunk. With the lazy MetricsPage of #3 you get most of the benefit; without `manualChunks` you may see Vite's >500KB warning at build time. Add the snippet from #3.

## 18. `tsconfig.base.json` is excellent (info)

**Severity**: Info — keep as-is

```json
{ "strict": true, "noUncheckedIndexedAccess": true, "noImplicitOverride": true,
  "module": "NodeNext", "moduleResolution": "NodeNext", "isolatedModules": true,
  "declaration": true, "declarationMap": true, "sourceMap": true }
```

The only easy add is `"exactOptionalPropertyTypes": true` (catches `undefined`-vs-missing bugs on optional fields) — historically painful with React props but the codebase is small enough to fix.

The admin-ui tsconfig is a separate file (because of `jsx: react-jsx` and `moduleResolution: Bundler`) but does not extend `tsconfig.base.json` — it duplicates the strict flags. Worth refactoring to extend the base and override only the bundler-specific options.

## 19. ESM hygiene is correct (info)

`.js` extensions on TypeScript imports are present (verified in http.ts, engine, warm-store) — that is the right choice for `module: NodeNext` ESM output. No top-level await; `main.ts` uses `async main()` + `await main()` pattern. No accidental CJS imports.

## 20. StrictMode on (info)

`packages/admin-ui/src/main.tsx` wraps `<App />` in `<StrictMode>`. Good — keeps you honest about effect cleanup, which will matter when you migrate to React 19.

---

## Recommended sequence (highest leverage first)

1. **#1** add `setErrorHandler` for ZodError → 400 (one hour, big UX win for API consumers).
2. **#3 + #17** lazy-load `MetricsPage` and add `manualChunks` (one hour).
3. **#5** `console.*` → `app.log.*` in main.ts (one hour).
4. **#2** introduce TanStack Query, migrate one page as proof, then fan out (half a day).
5. **#4** export Zod schemas, infer client types from them, delete duplicated client interfaces (half a day).
6. **#7** factor shared MCP tool registry (a few hours; tightens correctness too).
7. **#10** add react-router (small refactor; unlocks deep links).
8. **#8 + #9** scheduled major-bump sweep (a day).
9. **#15** bcryptjs → 3.0 now; argon2id with lazy-rehash later.
10. **#6** decide raw-pg vs Drizzle; either drop the dep or commit and add drizzle-kit.
