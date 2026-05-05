import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

/**
 * Regression test for the bin-via-symlink invocation path.
 *
 * `npm` / `npx` / `pnpm` link a package's bin into `node_modules/.bin/`
 * as a symlink to the real file. Earlier the entrypoint guard in
 * `dist/main.js` compared `import.meta.url` against
 * `\`file://${process.argv[1]}\`` — which never matched when invoked via
 * the symlink, so `npx @azrtydxb/novamem-init` exited silently with no
 * output. This test fails if anyone reverts to a guard that's not
 * symlink-aware.
 */
describe("bin entrypoint", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const distMain = join(here, "..", "dist", "main.js");
  // Source of truth for the published version. Asserting the CLI prints
  // *exactly* this catches stale hardcoded fallbacks (e.g. the prior
  // `PKG_VERSION = "0.1.0"` and the `0.0.0` catch-all in main.ts).
  const expectedVersion: string = JSON.parse(
    readFileSync(join(here, "..", "package.json"), "utf8"),
  ).version;

  it("--version prints the package.json version when invoked directly", () => {
    const out = execFileSync(process.execPath, [distMain, "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(out.trim()).toBe(expectedVersion);
  });

  it("--version prints the package.json version when invoked via a bin-style symlink", () => {
    // Recreate what npm does: a symlink in node_modules/.bin pointing
    // at the real dist/main.js. If the entrypoint guard mis-handles the
    // symlink, the CLI silently exits 0 with no output — asserting on
    // the exact version string catches both the silent-exit bug and
    // any stale fallback ("0.0.0", "0.1.0", etc.).
    const dir = mkdtempSync(join(tmpdir(), "novamem-init-"));
    const linkPath = join(dir, "novamem-init");
    try {
      mkdirSync(dir, { recursive: true });
      symlinkSync(distMain, linkPath);
      const r = spawnSync(process.execPath, [linkPath, "--version"], {
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect((r.stdout ?? "").trim()).toBe(expectedVersion);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
