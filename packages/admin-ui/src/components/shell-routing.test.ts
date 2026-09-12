import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NAV, navFor } from "./AppShell";

/** The failure this file exists to prevent.
 *
 *  `App.tsx` has no fallback route: it renders `{tab === "x" && <X/>}`
 *  per tab, so a nav entry whose literal is missing (or misspelled, or
 *  left behind by a rename) renders a *blank* main area under a nav item
 *  that still highlights. Nothing throws, nothing logs, and typechecking
 *  passes because both sides are valid `Tab` values independently.
 *
 *  The renaming of `metrics` → `overview` is exactly this shape, which
 *  is why it is guarded rather than merely done carefully. */
// Resolved from the package root, not `import.meta.url`: the test
// environment is happy-dom, where `import.meta.url` is an http:// URL
// and `fileURLToPath` refuses it.
const appSource = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");

describe("nav registry ↔ App render switch", () => {
  it("renders a page for every entry in the registry", () => {
    const missing = NAV.filter(
      (item) => !appSource.includes(`tab === "${item.id}"`)
    ).map((i) => i.id);
    expect(missing).toEqual([]);
  });

  it("has no render branch for a tab the registry dropped", () => {
    const known = new Set(NAV.map((i) => i.id as string));
    const routed = [...appSource.matchAll(/tab === "([a-z]+)"/g)].map(
      (m) => m[1]
    );
    const orphans = routed.filter((t) => !known.has(t));
    expect(orphans).toEqual([]);
  });
});

describe("navFor", () => {
  it("gives each role only its own pages", () => {
    const admin = navFor("admin").map((i) => i.id);
    const user = navFor("user").map((i) => i.id);
    expect(admin).toContain("users");
    expect(admin).not.toContain("browse");
    expect(user).toContain("browse");
    expect(user).not.toContain("users");
  });

  it("keeps the palette-only pages out of both sidebars", () => {
    // Getting started and Change password are reachable via ⌘K only. They
    // must not reappear as nav rows — but they must still exist in NAV,
    // because that is what gives them a route at all (#292).
    for (const role of ["admin", "user"] as const) {
      const ids = navFor(role).map((i) => i.id);
      expect(ids).not.toContain("onboarding");
      expect(ids).not.toContain("password");
    }
    expect(NAV.map((i) => i.id)).toContain("onboarding");
    expect(NAV.map((i) => i.id)).toContain("password");
  });

  it("gives every role a landing page", () => {
    expect(navFor("admin").map((i) => i.id)).toContain("overview");
    expect(navFor("user").map((i) => i.id)).toContain("home");
  });
});
