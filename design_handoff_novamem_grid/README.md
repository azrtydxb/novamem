# Handoff: NovaMem Admin/User Console — **Grid** direction

## Overview

NovaMem is a tiered-memory service for AI agents. Memories live in three stores:
**warm** (Postgres FTS, keyword), **cold** (Qdrant, vector), and **graph** (FalkorDB,
neighbours). A query fuses results from all three. Every access reinforces the
memory; idle memories decay (`effectiveDays = 7 · log₂(hits + 1)`) and demote
warm→cold or get reaped.

This handoff covers the **Grid** design direction: a modern technical SaaS aesthetic
(Linear / Vercel-grade polish) for the admin + end-user web console. It includes 11
screens across two roles (admin + user) in light + dark.

## About the design files

The HTML/JSX in this bundle is a **design reference** — a working React prototype
that demonstrates intended look, layout, and interaction. **It is not production
code to ship as-is.**

Recreate these designs in the target codebase using its existing framework, design
system, and patterns. If no frontend exists yet, use whatever's appropriate for the
project (Next.js + shadcn/ui, Vite + React, etc.) — the design tokens below are
framework-agnostic.

## Fidelity

**High-fidelity.** Final colors, typography, spacing, interactions. Recreate
pixel-faithfully against the design tokens listed at the bottom.

## Stack assumptions

- **Auth:** username + password → 24h session token in `sessionStorage`. Separate
  from the per-device `nm_…` bearer tokens used by agents (those have their own
  management UI in the Tokens screen).
- **Roles:** `admin` (cross-tenant) and `user` (scoped to one tenant). Same shell,
  different sidebar nav and different scope on every list/metric.
- **Tenancy:** every screen except admin-ops is implicitly scoped to the user's
  tenant. The tenant ID surfaces as a chip on the metrics page header.
- **Live data:** counters/gauges/rates polled every 5s. Show a live pill in the
  header. All counters are in-memory and reset on service restart — say so in the
  page subtitle.

## Screens

All 1280×800 unless noted. Sidebar is fixed-width (224px) on every screen.

### 1. Sign in (1100×720, centered card)

- **Card:** 380px wide, `panel` bg, 12px radius, 1px `rule` border, soft shadow
  (`0 12px 40px rgba(0,0,0,0.06)` light / `0 20px 60px rgba(0,0,0,0.4)` dark).
  32px padding.
- **Header row:** 36×36 logo tile (10px radius, `accent` fill, white synapse
  glyph) + brand name "NovaMem" (16px / 600) + version pill below in mono
  (`v0.4.2`).
- **Title:** "Sign in to your console" (20px / 600, letter-spacing −0.015em).
- **Subtitle:** "Use your dashboard username — not a bearer token." (13px, `dim`).
- **Fields:** Username, Password — 12px label / 600, 8px radius input, 10×12
  padding, focus ring on `accent`.
- **CTA:** full-width primary button "Continue" — 11px padding, `accent` fill,
  white text, 13px / 600.
- **Footer:** mono caption "Session expires in 24h · stored in sessionStorage".

### 2. Onboarding (max-width 880, 5-step list)

- **Eyebrow chip:** "Welcome" — `accentSoft` bg, `accent` text, mono uppercase.
- **Title:** "Let's give your agent memory" (36px / 600).
- **Subtitle:** "5 steps · 2 already done" (15px, `dim`).
- **Step list card:** rounded panel, each row 20×22 padding, 1px soft rule between
  rows. Each row: 36×36 status disc + label + hint + action.
  - Disc states: **done** (`accent` fill, white check), **active** (panel bg,
    2px `accent` border, `accent` number), **queued** (transparent, 2px `rule`
    border, `faint` number).
  - Active row: full row tinted `accentSoft`. Has primary "Continue →" button.
- **3-tile foot:** Warm (`warm` dot), Cold (`cold` dot), Graph (`graph` dot) —
  each tile shows tier name + 1-line description in mono.
- **Steps:** 1) Bootstrap admin (done) · 2) Tenant created (done) · 3) Mint
  first token (active) · 4) Connect agent · 5) Remember something.

### 3. Metrics (hero — admin and user)

Sidebar + content. Header row, 4-up KPI strip, 2-up main charts, 4-up gauges,
then a wide lifecycle band (admin) OR Projects + Today (user).

- **Header:** Title "Metrics" (22px / 600) + live pill "● live · 5 s"
  (`accentSoft`/`accent`) + tenant pill if user. Subtitle: "Cross-tenant counters,
  gauges, and rates. In-memory; resets on restart." Right-aligned: secondary
  "↻ Refresh" + (admin only) primary "Run decay".
- **KPI cards (4):** each card 14×16 padding, label (12px / 500 / `dim`) +
  delta pill (mono 10px, `↑/↓ N.N%`, green=`graph`/`graphSoft`,
  amber=`warm`/`warmSoft`) on top row. Big value (26px / 600,
  letter-spacing −0.02em, tabular-nums) + 72×22 sparkline (1.5px stroke).
  - Cards: Queries/sec · Remembers/sec · Total queries · Decay runs (admin) /
    Total remembers (user).
- **Throughput chart (left, 2/3 width):** 800×210 SVG. Gridlines at 25/50/75%
  in `ruleSoft`. Two filled areas (queries `accent`, remembers `graph`) with
  vertical gradient stops 0.30→0 and 0.22→0. Lines on top.
- **Hits-per-tier (right, 1/3 width):** 3 stacked bars, label + count + percent
  on the right, 6px tall track in `subtle`, fill in tier color.
- **Gauges row (4):** `warm_entries`, `cold_entries`, `graph_edges`,
  `orphans_pending` — same KPI card shape, no spark, value tinted in tier color.
- **Admin lifecycle band:** wide card. Subtitle includes the decay formula
  (`effectiveDays = 7 · log₂(hits + 1)`) and last-run timestamp. 5 vertical
  cells: Remembers · Forgets · Promotions ↑ (`graph`) · Demotions ↓ (`warm`) ·
  Reaped.
- **User home, instead of lifecycle:** two cards side-by-side — "My projects"
  (per-row tile, mono row meta) and "Today" (recent activity, last 5).

### 4. Browse memories

- **Header:** kicker "Hybrid search · keyword + vector + graph", title "Browse
  memories", primary "+ Remember".
- **Search bar:** card row, ⌕ glyph + flex input + scope `<select>`
  (project/atlas/tenant) + `k=10` chip.
- **Results header strip:** mono summary "N hits · 23 ms" left + tier
  legend right (warm/cold/graph dots with counts).
- **Result row (grid: tier-pill | content+meta | score | hits | decay):**
  - **Tier pill:** mono 9px uppercase, `warmSoft`/`coldSoft` bg, `warm`/`cold` text.
  - **Content:** 13px / 1.5 line-height, `ink`. Meta line below: id · project
    · ns · age, mono 10px `dim`.
  - **Score:** 16px / 600 in `accent`, tabular-nums.
  - **Hits:** 16px / 600 in `ink`, tabular-nums.
  - **Decay bar:** mono caption "decay N%" + 4px track. Fill `warm` if >60%, else `cold`.

### 5. Memory graph

- **Header:** kicker "Neighbours · seed m_…", title "Memory graph", right pill
  "● falkor degraded · 412 ms p95" in `warmSoft`/`warm`.
- **Layout:** 1fr graph card + 280px inspector card.
- **Graph SVG (800×460):** edges = grey lines, width = `weight × 1.6`,
  opacity 0.4. Nodes = circles, radius `8 + hits × 0.45`, fill = tier color
  (warm or cold), 3px `panel`-color stroke. Selected seed has a `radialGradient`
  glow halo (3.5× node radius). Labels below node: 11px `ink` (sans), 9px
  `faint` (mono id). Click any node → it becomes the new seed (re-render).
- **Inspector:** node label + id, 2-up stat (Hits · Edges), tier line, hint.

### 6. Today

- Header: kicker "Activity · 2026-05-02", title "Today".
- Card with timeline rows (grid: dot | time | meta+text):
  - 8px colored dot — color by kind: `remember`=`graph`, `search`=`accent`,
    `decay`=`warm`, `share`=`graph`, `token`=`accent`, `forget`=`err`.
  - Mono time stamp `dim`.
  - Top: kind chip (mono 9px uppercase, `subtle` bg) + optional project name (mono `faint`).
    Below: 13px `ink` event text.

### 7. Projects (user)

- Header: kicker "Sub-brains · scoped memory", title "Projects", primary "+ New project".
- 3-col grid of cards (`panel`/`rule`/8px radius/18px padding).
- Each card: 36×36 ▢ glyph tile (`accentSoft`/`accent`), name (15px / 600) + id
  in mono `dim`. "shared" pill (mono 9px uppercase, `warmSoft`/`warm`) right-aligned
  if cross-tenant.
- Stat row (3 cells): Memories · Members · Tokens — 18px / 600 value,
  9px mono uppercase label.
- Foot row above a top rule: role + last-activity (mono `dim`) | "open →" (`accent`).

### 8. API tokens

- Header: kicker "Per-device · plaintext shown once", title "API tokens",
  primary "+ Mint token".
- Layout: 1fr token table | 320px usage card.
- **Table:** column headers in mono uppercase 10px on `subtle` bg. Columns:
  Label · Scope · Hash · Last used · 24h · ··· (revoke).
  - Scope chip: mono 10px in `accentSoft`/`accent` for tenant scope,
    `warmSoft`/`warm` for project-scoped.
  - Hash: mono 11px `faint`.
  - Revoke link: 11px `err`.
- **Usage card:** per-token row with name + count + horizontal bar
  (4px track, fill `accent` or `warm` by scope).

### 9. Health (admin)

- 2-col grid of dependency cards.
- Each card: status dot (8px) with 3px halo (`graphSoft` if ok, `warmSoft` if
  degraded) + name (15px / 600) + role (mono `dim`). Mono host/version line below.
- 80×28 sparkline center, value right (18px / 600 in `graph`/`warn` + "ms" mono),
  status pill (mono uppercase) below.

### 10. Tenants (admin)

- Table card. Columns: Tenant · Users · Tokens · Memories · Created · ··· (purge).
- Tenant cell: 30×30 monogram tile (`accentSoft`/`accent`, first letter, 13/600)
  + name (13/500) + id (mono `dim`).
- Numeric cells: 13/inherit, tabular-nums.
- Purge link: 11px `err`.

### 11. Users (admin)

- Table card. Columns: User · Role · Tenant · Last seen · ··· (edit/delete).
- User cell: 30×30 round avatar (`subtle` bg, `dim` initial, 12/600) + username (13/500).
- Role chip: mono 10px uppercase. `admin` = `accentSoft`/`accent`. Others = `subtle`/`dim`.
- Tenant column: mono `dim`. Last seen: mono `faint`.

## Sidebar (every authenticated screen)

- 224px fixed width, `panel` bg, 1px `rule` right border.
- **Brand block:** 28×28 `accent` rounded-square tile with white synapse glyph
  (4 lines from corners → center, 1.4 stroke, plus a 2.6 center dot). Brand
  name (14/600). Mono caption: `admin` or tenant id.
- **Nav section header:** 10px mono uppercase, `faint` color, 0.10em letter-spacing.
- **Nav button:** 7×10 padding, 6px radius. Active: `subtle` bg + `ink` 500-weight
  + `accent` glyph. Inactive: transparent + `dim` text + `faint` glyph.
- **Glyphs (mono):** Metrics ◐ · Health ◇ · Tenants ▢ · Users ○ · Browse ≡ ·
  Graph ✦ · Today ◷ · Projects ▢ · Tokens ⌘.
- **Footer:** 28×28 round avatar (initial in `accentSoft`/`accent`) + username (12/500)
  + role/tenant (mono 10/`dim`).
- **Admin nav:** Metrics · Health · Tenants · Users.
- **User nav:** Metrics · Browse · Graph · Today · Projects · API Tokens.

## Interactions

- **Sidebar nav:** synchronous client-side route swap.
- **Refresh:** GET `/api/metrics`, replace card values + chart data. Optimistic
  spinner on the button itself.
- **Run decay (admin):** POST `/api/decay/run`. On success, toast + recompute
  the lifecycle band.
- **Browse search:** debounced (200ms) on input change; tier counts and
  ms-counter update on response.
- **Graph node click:** set seed = node id, re-fetch subgraph, animate halo
  fade-in (200ms).
- **Mint token (Tokens page):** modal → on submit returns plaintext **once** in
  a copy-once card with strong warning. Add to table with last-used "—".
- **Revoke token / purge tenant / delete user:** confirm modal with the
  destructive verb in `err`.

## States

- **Live pill:** dot pulses every 5s (`@keyframes` opacity 1 → 0.4 → 1).
- **Loading rows:** show 3 skeleton rows with `subtle`-color rectangles at
  table column widths; 1.5s shimmer.
- **Empty:** "No memories yet" with single primary CTA mirroring step 5 of onboarding.
- **Error:** inline banner above the affected card, `err` 1px border + tinted
  bg, mono code on the right (e.g. `502 BAD_GATEWAY`).
- **Degraded dependency (Health):** `warn` color throughout the card; subtitle
  mentions falkor specifically. Graph page header repeats the warning pill.

## Design tokens

```css
/* Light */
--bg:        #fafbfc;
--panel:     #ffffff;
--subtle:    #f3f5f8;
--ink:       #0d1117;
--dim:       #5b6470;
--faint:     #8b94a3;
--rule:      #e6e9ee;
--rule-soft: #eef0f4;
--accent:        oklch(58% 0.15 250); /* indigo-blue, primary action */
--accent-soft:   oklch(95% 0.04 250);
--warm:          oklch(62% 0.16 35);  /* warm-tier signal, demotions */
--warm-soft:     oklch(95% 0.04 35);
--cold:          oklch(58% 0.13 220); /* cold-tier signal */
--cold-soft:     oklch(95% 0.04 220);
--graph:         oklch(60% 0.16 165); /* graph-tier, promotions, ok */
--graph-soft:    oklch(95% 0.04 165);
--err:           oklch(58% 0.20 25);
--warn:          oklch(70% 0.16 80);

/* Dark */
--bg:        #0a0d12;
--panel:     #11151c;
--subtle:    #161b24;
--ink:       #e6ebf2;
--dim:       #8a93a3;
--faint:     #5a6373;
--rule:      #1f2530;
--rule-soft: #171c25;
--accent:        oklch(70% 0.16 250);
--accent-soft:   oklch(28% 0.10 250);
--warm:          oklch(72% 0.17 35);
--warm-soft:     oklch(28% 0.10 35);
--cold:          oklch(72% 0.14 220);
--cold-soft:     oklch(28% 0.10 220);
--graph:         oklch(72% 0.16 165);
--graph-soft:    oklch(28% 0.10 165);
--err:           oklch(70% 0.20 25);
--warn:          oklch(78% 0.16 80);
```

### Type

- **Sans:** `Inter` (400/500/600/700) for everything except numerics.
- **Mono:** `JetBrains Mono` (400/500/600) for ids, hashes, timestamps, kind chips,
  metric labels, tabular metadata.
- **Tabular numerals:** apply `font-variant-numeric: tabular-nums` to every
  number in tables, KPI values, and stats.
- **Letter-spacing:** −0.02em on h1/h2/big-stat values; default elsewhere.

### Spacing scale

`4 · 6 · 8 · 10 · 12 · 14 · 18 · 20 · 24 · 28 · 32` (px). Card padding mostly
`14×18` for headers, `18` for body. Page padding `20`.

### Radii

`4` (chips), `6` (buttons, inputs), `8` (cards, tiles), `12` (auth card, big shells), `99` (pills).

### Shadows

- `--shadow-card` (light): `0 1px 2px rgba(13, 17, 23, 0.04)` — used sparingly,
  cards rely on borders not shadows.
- `--shadow-modal` (light): `0 12px 40px rgba(0, 0, 0, 0.06)`.
- `--shadow-modal` (dark): `0 20px 60px rgba(0, 0, 0, 0.4)`.

### Status pill recipe

```
font: 600 10px/1 'JetBrains Mono';
letter-spacing: 0.06em;
text-transform: uppercase;
padding: 2px 8px;
border-radius: 99px;
background: var(--<token>-soft);
color:      var(--<token>);
```

## Data shape (mock)

See `data.jsx` for the full shape. Notable fields:

- `metrics.counters`: `queries_total`, `queries_zero_hit`, `remembers_total`,
  `forgets_total`, `hits_warm_total`, `hits_cold_total`, `hits_graph_total`,
  `decay_runs_total`, `promotions_total`, `demotions_total`, `orphans_reaped_total`.
- `metrics.gauges`: `warm_entries`, `cold_entries`, `graph_edges`, `orphans_pending`.
- `metrics.rates`: `queries_per_sec_60s`, `remembers_per_sec_60s`.
- `history`: array of `{q, r}` 60-second buckets for the throughput chart.
- `memories`: id, content, tier (`warm`|`cold`), score, hits, decay (0..1),
  project, namespace, age.
- `graph.nodes`: `{id, label, x, y, hits, tier}` (x, y are 0..1 normalized).
- `graph.edges`: `[fromId, toId, weight]`.
- `tokens`, `tenants`, `users`, `health`, `projects`, `today` — see file.

## Files

- `Grid Direction.html` — runnable design canvas of all 11 screens × user/admin × light/dark.
- `direction-grid.jsx` — full component implementation (sidebar, all pages, auth, onboarding).
- `data.jsx` — mock data shape for everything above.
- `design-canvas.jsx` — canvas wrapper used to lay out the screens; not needed in production.

## Implementation tips

- The KPI card pattern (label + delta + value + sparkline) is used 8+ times.
  Build it as a single component first.
- The table pattern (header strip on `subtle` + grid rows with soft rules)
  generalizes across Tokens, Tenants, Users, Memories. Build a small `<DataTable>`
  primitive.
- Tier color (`warm`/`cold`/`graph`) is a recurring axis. Encode it as a single
  `tone` prop everywhere it appears (pills, dots, fills, strokes).
- The graph view on a real DB will need a force-layout pass; the prototype uses
  hand-placed normalized positions. Pick a small library
  (`d3-force`, `cytoscape`, or `react-force-graph`) and don't try to
  hand-roll it.
- "In-memory; resets on restart" needs to actually be true on the backend or the
  copy is a lie. Keep that subtitle if the backend matches; rewrite it otherwise.
