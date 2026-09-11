#!/usr/bin/env node
// Documentation smoke tests — guards against the high-risk stale claims
// that caused real drift in the past. See issue #73.
//
// Plain Node, no deps. Walks a fixed set of doc paths, runs regex checks
// against each line, and exits non-zero with actionable messages
// (`<file>:<line> — <what's wrong>`) when any invariant fails.

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

// Doc roots scanned for invariants. Files outside these are not subject to
// the doc-content checks, but the global "no Co-Authored-By / no P[0-9]-"
// trailer sweep walks the whole tree (excluding noise dirs, see below).
const DOC_TARGETS = [
  "docs",
  "packages/docs-site",
  "skills",
  "README.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
];

// Per-package READMEs are public surface too.
async function expandPackageReadmes() {
  const pkgsDir = join(ROOT, "packages");
  const out = [];
  try {
    const entries = await readdir(pkgsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const readme = join("packages", e.name, "README.md");
      try {
        await stat(join(ROOT, readme));
        out.push(readme);
      } catch {
        // package has no README — fine.
      }
    }
  } catch {
    // no packages dir — fine.
  }
  return out;
}

async function walkFiles(relPath) {
  const abs = join(ROOT, relPath);
  let st;
  try {
    st = await stat(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return [relPath];
  const out = [];
  const entries = await readdir(abs, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.name === "node_modules" || e.name === "dist") continue;
    const child = join(relPath, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(child)));
    else if (e.isFile() && /\.(md|mdx|markdown|txt)$/i.test(e.name))
      out.push(child);
  }
  return out;
}

// Walk the whole tree (excluding noise) for the "no leftover trailer" check.
async function walkAllText(relPath = ".") {
  const SKIP = new Set([
    ".git",
    "node_modules",
    ".claude",
    "dist",
    ".turbo",
    ".next",
    "coverage",
    "pnpm-lock.yaml",
  ]);
  const abs = join(ROOT, relPath);
  let st;
  try {
    st = await stat(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return [relPath];
  const out = [];
  const entries = await readdir(abs, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const child = relPath === "." ? e.name : join(relPath, e.name);
    if (e.isDirectory()) out.push(...(await walkAllText(child)));
    else if (
      e.isFile() &&
      /\.(md|mdx|markdown|txt|yml|yaml|json|ts|tsx|js|mjs|cjs|sh)$/i.test(
        e.name
      )
    ) {
      out.push(child);
    }
  }
  return out;
}

const failures = [];
function fail(file, line, msg) {
  failures.push(`${file}${line ? `:${line}` : ""} — ${msg}`);
}

async function readLines(relFile) {
  const text = await readFile(join(ROOT, relFile), "utf8");
  return text.split(/\r?\n/);
}

// ── Invariants ────────────────────────────────────────────────────────

// 1. Public /health is `{ ok }` only — never `{ ok, deps }`.
//    Catches: documenting public health as if it still exposes deps.
function checkPublicHealthShape(file, lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Look for `{ ok, deps }`-shaped descriptions of /health.
    // Trigger when the line mentions /health (not /admin/health/deep) AND
    // contains a deps-bearing object literal.
    if (/\/health\b/.test(line) && !/\/admin\/health\/deep/.test(line)) {
      if (/\{\s*ok\s*,\s*deps\b/.test(line)) {
        fail(
          file,
          i + 1,
          "public /health described with `{ ok, deps }` — should be `{ ok }` only"
        );
      }
    }
  }
}

// 2. If deep dependency health is mentioned, it must point at
//    `/v1/admin/health/deep`. Catches stale `/health/deep` or
//    `/admin/health/deep` (missing the `/v1/` prefix).
function checkDeepHealthPath(file, lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Bare `/health/deep` (not preceded by /v1/admin) is wrong.
    if (/(?<!\/v1\/admin)\/health\/deep\b/.test(line)) {
      fail(file, i + 1, "deep health endpoint must be `/v1/admin/health/deep`");
    }
    // `/admin/health/deep` without the `/v1/` prefix is wrong.
    if (/(?<!\/v1)\/admin\/health\/deep\b/.test(line)) {
      fail(
        file,
        i + 1,
        "deep health endpoint must be `/v1/admin/health/deep` (missing `/v1/` prefix)"
      );
    }
  }
}

// 3. Project-sharing docs must say "exact email" / "exact invitee email".
//    Catches stale wording like "share with username" or "display name"
//    in project_share / project_unshare context.
function checkProjectShareWording(file, lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/project_share|project_unshare|\/projects\/[^\s]*\/share/.test(line))
      continue;
    // Allow if the surrounding window (±3 lines) explicitly mentions "exact
    // email" / "exact invitee email" — that's the canonical wording, and
    // a literal `username` token in a code-block parameter name is fine
    // when paired with the right prose nearby.
    const lo = Math.max(0, i - 3);
    const hi = Math.min(lines.length, i + 4);
    const window = lines.slice(lo, hi).join("\n");
    const hasCanonical = /exact (invitee )?email/i.test(window);
    if (/\busername\b/i.test(line) && !hasCanonical) {
      fail(
        file,
        i + 1,
        "project share/unshare docs reference `username` — should be exact invitee email"
      );
    }
    if (/\bdisplay name\b/i.test(line) && !hasCanonical) {
      fail(
        file,
        i + 1,
        "project share/unshare docs reference `display name` — should be exact invitee email"
      );
    }
  }
}

// 4. Lifecycle endpoints (`/v1/decay`, `/v1/dream-cycle`, `/v1/reap-orphans`)
//    must NOT be described as public / open / unauthenticated. We don't
//    require the word "admin" near every mention (would be too noisy in
//    architecture/usage prose), but we DO fail any line that pairs a
//    lifecycle endpoint with wording that contradicts admin-only — e.g.
//    "any user", "publicly", "no auth", "unauthenticated".
function checkLifecycleAdminOnly(file, lines) {
  if (file.endsWith(".json")) return;
  const endpoints = ["/v1/decay", "/v1/dream-cycle", "/v1/reap-orphans"];
  const contradictions =
    /\b(any user|anyone|public(ly)?|no auth(entication)?|unauthenticated|without auth)\b/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const ep of endpoints) {
      if (!line.includes(ep)) continue;
      const lo = Math.max(0, i - 3);
      const hi = Math.min(lines.length, i + 4);
      const window = lines.slice(lo, hi).join("\n");
      if (contradictions.test(window)) {
        fail(
          file,
          i + 1,
          `lifecycle endpoint ${ep} described as non-admin (contradicts admin-only policy)`
        );
      }
    }
  }
}

// 5. Public docs must not advertise retired tenant-admin APIs or stale token routes.
function checkNoStaleTenantAdminDocs(file, lines) {
  const stale = [
    [/\/v1\/admin\/tenants\b/, "retired tenant admin endpoint documented"],
    [
      /\/v1\/admin\/decay\/(run|config)\b/,
      "retired admin decay endpoint documented",
    ],
    [
      /tenant_tokens|resolveTenantToken|Tenant tokens/i,
      "stale tenant-token model documented",
    ],
    [
      /\/v1\/me\/tokens\/<hash>\/revoke|\/v1\/me\/tokens\/\{hash\}\/revoke/,
      "stale token revoke route documented",
    ],
    [
      /\/api-docs\/openapi\.json/,
      "raw OpenAPI URL is `/openapi.json`, not `/api-docs/openapi.json`",
    ],
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const [re, msg] of stale) {
      if (re.test(lines[i])) fail(file, i + 1, msg);
    }
  }
}

// 6. Deployment templates must not make unsafe placeholders look applyable.
function checkDeployFootguns(file, lines) {
  if (
    file === "deploy/k8s/kustomization.yaml" &&
    lines.some((l) => /^\s*-\s*secrets\.yaml\s*$/.test(l))
  ) {
    fail(
      file,
      null,
      "default kustomization must not apply placeholder secrets.yaml"
    );
  }
  if (
    file === "deploy/k8s/falkordb.yaml" &&
    lines.some((l) => /image:\s*falkordb\/falkordb:(latest|edge)\b/.test(l))
  ) {
    fail(file, null, "FalkorDB image must be pinned, not latest/edge");
  }
}

// 7. No leftover `Co-Authored-By: Claude` trailers anywhere (excl. noise).
//    Match only actual trailer-shaped lines: optional leading whitespace
//    or markdown list/quote markers, then the literal trailer at the
//    start. Prose that mentions the trailer in backticks/quotes (e.g. the
//    CHANGELOG entry that records its removal) is intentionally allowed.
function checkNoCoAuthoredByClaude(file, lines) {
  const trailerRe = /^\s*Co-Authored-By:\s*Claude/;
  for (let i = 0; i < lines.length; i++) {
    if (trailerRe.test(lines[i])) {
      fail(file, i + 1, "leftover `Co-Authored-By: Claude` trailer");
    }
  }
}

// 6. No leftover `P[0-9]-` review markers in docs.
function checkNoReviewMarkers(file, lines) {
  for (let i = 0; i < lines.length; i++) {
    if (/\bP[0-9]-[A-Za-z0-9_-]+/.test(lines[i])) {
      fail(file, i + 1, "leftover `P[0-9]-` review marker");
    }
  }
}

// ── Run ──────────────────────────────────────────────────────────────

// 9. Every server endpoint a doc names must exist in the generated
//    OpenAPI spec.
//
//    The invariants above are each a reaction to one past drift, so they
//    only catch drift somebody already predicted. This one is derived
//    from the route table itself, so it catches endpoints renamed or
//    removed in future without anyone adding a rule here. Retroactively
//    it is what would have caught `/api-docs` surviving the Fastify
//    server's deletion (issue #264).
//
//    Deliberately conservative: only paths written as a code span, with
//    our API's shape, are considered. A noisy invariant gets switched
//    off, which is worse than not having one.
let specMatchers = null;
async function loadSpecMatchers() {
  if (specMatchers) return specMatchers;
  const spec = JSON.parse(
    await readFile(join(ROOT, "docs/api/openapi.json"), "utf8")
  );
  // `/v1/memories/{id}` -> matcher that accepts any single segment there.
  specMatchers = Object.keys(spec.paths ?? {}).map((p) => ({
    path: p,
    re: new RegExp(
      "^" +
        p
          .split("/")
          .map((seg) =>
            seg.startsWith("{") && seg.endsWith("}")
              ? "[^/]+"
              : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          )
          .join("/") +
        "$"
    ),
  }));
  return specMatchers;
}

// Served, but deliberately not an OpenAPI operation. Each entry states
// why, so this cannot quietly become a place to silence real failures.
const NON_OPERATION_PATHS = new Map([
  ["/openapi.json", "the spec does not describe itself"],
  ["/api-docs", "the rendered view of the spec, not an operation in it"],
  ["/metrics", "Prometheus exposition, not a JSON API operation"],
  ["/admin", "dashboard SPA shell"],
  ["/favicon.ico", "static asset"],
  ["/v1/rerank", "upstream LiteLLM gateway route, not served by novamem"],
  // Removed in ADR 0007 — the HTTP+SSE transport from revision
  // 2024-11-05, Deprecated by the MCP spec. Docs may still name these
  // paths, but only to say they are gone and what replaced them; a doc
  // that tells a reader to USE one is caught by the reviewer, not here.
  ["/mcp/sse", "removed in ADR 0007; docs name it only to say so"],
  ["/mcp/messages", "removed in ADR 0007; docs name it only to say so"],
]);

// Docs that describe history or a past audit rather than today's server.
const HISTORICAL_DOCS = [
  /(^|\/)CHANGELOG\.md$/i,
  /(^|\/)changelog\.md$/i,
  /(^|\/)adr\//i,
  /go-parity-audit\.md$/,
  // Superpowers plans and specs record what was designed at a point in
  // time. They are not instructions to follow and go stale on purpose.
  /(^|\/)superpowers\//,
];

async function checkEndpointsExist(file, lines) {
  if (HISTORICAL_DOCS.some((re) => re.test(file))) return;
  const matchers = await loadSpecMatchers();
  for (let i = 0; i < lines.length; i++) {
    // Only code spans — prose mentions are too loose to judge.
    for (const span of lines[i].matchAll(/`([^`]+)`/g)) {
      const text = span[1].trim();
      // A bare path, optionally prefixed by an HTTP method.
      const m = text.match(
        /^(?:(?:GET|PUT|POST|PATCH|DELETE)\s+)?(\/[A-Za-z0-9._/{}-]*)$/
      );
      if (!m) continue;
      const p = m[1];
      // Prefixes like `/v1/` describe a family, not an endpoint.
      if (p.endsWith("/")) continue;
      if (NON_OPERATION_PATHS.has(p)) continue;
      // Only judge paths that look like this server's surface.
      if (!/^\/(v1|mcp|api-docs|health|live|ready)\b/.test(p)) continue;
      if (matchers.some((mm) => mm.re.test(p))) continue;
      // A route the docs explicitly present as future work is an honest
      // reference, not a false claim — but the marker has to be on the
      // line, so it cannot be used to wave through a stale endpoint.
      if (
        /\b(?:planned|proposed|not yet implemented|does not exist yet)\b/i.test(
          lines[i]
        )
      ) {
        continue;
      }
      fail(
        file,
        i + 1,
        `documents endpoint ${p}, which is not in docs/api/openapi.json — ` +
          `remove the claim, or add the route and regenerate the spec`
      );
    }
  }
}

// `docs/` is the single source the VitePress site builds from (srcDir in
// packages/docs-site/.vitepress/config.mts). Before that, the same pages
// were maintained by hand in both places and drifted in both directions —
// the site knew about pgvector and memory_relations while docs/ still
// described FalkorDB, and docs/ had a whole pgvector Kubernetes section
// the site had never seen. Nobody predicted either drift, because a
// second copy drifts silently by construction.
//
// So: no page may exist under packages/docs-site/ at all. The package
// holds the config and the static assets, nothing readable.
async function checkNoSecondCopyOfDocs() {
  const strays = (await walkFiles("packages/docs-site")).filter(
    (f) => f.endsWith(".md") && !f.includes("node_modules")
  );
  for (const f of strays) {
    fail(
      f,
      1,
      "a page under packages/docs-site/ — docs/ is the only source the " +
        "site builds from; move it to docs/ so there is one copy"
    );
  }
}

// The API reference renders on two surfaces: the site bundles Scalar
// through packages/docs-site, and the server embeds its own copy and
// serves it at /api-docs so an air-gapped deployment still has a
// reference. Two copies of a version number is exactly the shape that
// drifts, and a reader landing on one surface would silently get a
// different renderer than the other. The embedded VERSION is the source;
// the site must depend on the same one.
async function checkApiReferenceVersionsAgree() {
  const file = "go/internal/httpapi/apidocs/VERSION";
  const pkg = "packages/docs-site/package.json";
  let embedded;
  try {
    embedded = (await readFile(join(ROOT, file), "utf8")).trim();
  } catch {
    return fail(file, 1, "missing — run go/scripts/sync-api-reference.sh");
  }
  const lines = await readLines(pkg);
  const i = lines.findIndex((l) => l.includes('"@scalar/api-reference"'));
  if (i < 0) {
    return fail(
      pkg,
      1,
      "does not depend on @scalar/api-reference — the interactive reference page cannot render"
    );
  }
  const pinned = /"@scalar\/api-reference":\s*"([^"]+)"/.exec(lines[i])?.[1];
  if (pinned !== embedded) {
    fail(
      pkg,
      i + 1,
      `pins @scalar/api-reference ${pinned} but the server embeds ${embedded} ` +
        `(${file}) — the site and /api-docs must render with the same version`
    );
  }
}

// The tool catalogue in docs/api/mcp-tools.md is GENERATED from
// tooldefs.json (`go run ./cmd/gen-tool-docs`, with a CI drift gate), so
// it cannot disagree with the surface and needs no check here.
//
// The skill reference pages cannot be generated — they are deep-dives
// with worked examples, which is prose by nature. What they must never
// do is name a tool that does not exist: a reader following a reference
// to a removed tool gets a call that fails with no clue why. So this
// checks one direction only, which is the direction prose can get wrong
// without anyone noticing.
const TOOL_PROSE_DOCS = [
  "skills/novamem/references/search.md",
  "skills/novamem/references/remember.md",
  "skills/novamem/references/projects.md",
];

const TOOL_MENTION = /`((?:memory|project)_[a-z_]+)`/g;

// Identifiers that share the tools' naming shape without being tools.
// There is no generated source to derive these from — `memoryType`
// values exist only in stored metadata and prose — so they are declared
// here with their reason, and the check below fails if one of them ever
// becomes a real tool, which would make the exemption a blindfold.
const NON_TOOL_IDENTIFIERS = new Map([
  [
    "project_convention",
    "a memoryType value (references/remember.md), not a tool",
  ],
]);

async function checkToolProseNamesNoPhantomTools() {
  const defsPath = "go/internal/mcp/tooldefs.json";
  let advertised;
  try {
    const defs = JSON.parse(await readFile(join(ROOT, defsPath), "utf8"));
    advertised = new Set(defs.map((d) => d.name));
  } catch (err) {
    return fail(
      defsPath,
      1,
      `unreadable, so the tool docs cannot be checked: ${err.message}`
    );
  }

  for (const [name, why] of NON_TOOL_IDENTIFIERS) {
    if (advertised.has(name)) {
      fail(
        "scripts/doc-smoke.mjs",
        1,
        `NON_TOOL_IDENTIFIERS exempts \`${name}\` as "${why}", but it is now an advertised ` +
          `tool — remove the exemption or the docs stop being checked for it`
      );
    }
  }

  for (const file of TOOL_PROSE_DOCS) {
    let text;
    try {
      text = await readFile(join(ROOT, file), "utf8");
    } catch {
      fail(file, 1, "missing — it is part of the skill bundle and is required");
      continue;
    }
    const lines = text.split("\n");
    const named = new Set();
    for (const m of text.matchAll(TOOL_MENTION)) named.add(m[1]);
    for (const name of [...named].sort()) {
      if (advertised.has(name) || NON_TOOL_IDENTIFIERS.has(name)) continue;
      const line = lines.findIndex((l) => l.includes("`" + name + "`")) + 1;
      fail(
        file,
        line || 1,
        `documents \`${name}\`, which is not an advertised MCP tool`
      );
    }
  }
}

async function main() {
  // Doc-content invariants on doc files only.
  const docFiles = new Set();
  for (const t of DOC_TARGETS) {
    for (const f of await walkFiles(t)) docFiles.add(f);
  }
  for (const r of await expandPackageReadmes()) docFiles.add(r);

  await checkNoSecondCopyOfDocs();
  await checkApiReferenceVersionsAgree();
  await checkToolProseNamesNoPhantomTools();

  for (const file of docFiles) {
    const lines = await readLines(file);
    checkPublicHealthShape(file, lines);
    checkDeepHealthPath(file, lines);
    checkProjectShareWording(file, lines);
    checkLifecycleAdminOnly(file, lines);
    checkNoStaleTenantAdminDocs(file, lines);
    checkNoReviewMarkers(file, lines);
    await checkEndpointsExist(file, lines);
  }

  // Whole-tree sweep for stale Co-Authored-By trailers (excluding .git,
  // node_modules, .claude worktrees, dist).
  const allFiles = await walkAllText(".");
  for (const file of allFiles) {
    // The check script itself contains the literal string by necessity —
    // skip it.
    if (file === relative(ROOT, new URL(import.meta.url).pathname)) continue;
    if (file.endsWith("scripts/doc-smoke.mjs")) continue;
    const lines = await readLines(file);
    checkDeployFootguns(file, lines);
    checkNoCoAuthoredByClaude(file, lines);
  }

  if (failures.length > 0) {
    console.error(`doc-smoke: ${failures.length} failure(s):\n`);
    for (const f of failures) console.error(`  ${f}`);
    console.error("");
    process.exit(1);
  }
  console.log(
    `doc-smoke: OK (scanned ${docFiles.size} doc file(s), ${allFiles.length} tree file(s))`
  );
}

main().catch((err) => {
  console.error("doc-smoke: crashed:", err);
  process.exit(2);
});
