// Flat ESLint config. The linter exists so procoder's lint domain can
// check this repo's JavaScript and TypeScript — an unchecked file counts
// as failing the gate, and the repo previously had no config at all.
//
// Deliberately the recommended sets and nothing bespoke: procoder adds no
// rules of its own and the project's config wins, so house style stays a
// decision made on purpose rather than inherited from a preset pile.
// Formatting belongs to prettier and is not duplicated here.
import js from "@eslint/js";

// typescript-eslint refuses to load against TypeScript 7 (this repo is on
// 7.x); support is tracked in typescript-eslint#10940. The version is
// checked BEFORE importing, because the module prints its refusal to
// stderr as it throws — which made every eslint run look like it had
// failed, and procoder's lint gate report the file as unchecked.
//
// The guard is a hard version floor, NOT a capability probe: it cannot
// tell whether the installed typescript-eslint has gained TS 7 support.
// When #10940 ships, DELETE the tsMajor check below — nothing else here
// needs to change, but nothing enables TypeScript linting on its own.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let typescriptConfigs = [];
let typescriptUnavailable = null;
try {
  const tsMajor = Number(
    require("typescript/package.json").version.split(".")[0]
  );
  if (tsMajor >= 7) {
    typescriptUnavailable = `typescript-eslint does not support TypeScript ${tsMajor} yet (typescript-eslint#10940)`;
  } else {
    typescriptConfigs = (await import("typescript-eslint")).default.configs
      .recommended;
  }
} catch (err) {
  typescriptUnavailable = err instanceof Error ? err.message : String(err);
}

export default [
  {
    // Generated, vendored, or not ours to lint.
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "site/**",
      "go/**",
      "packages/docs-site/.vitepress/cache/**",
      "**/*.d.ts",
      // Without a TypeScript parser every .ts file would report a syntax
      // error that says nothing about the code. Procoder still reports
      // these files as NOT checked, which is the honest state — better a
      // visible gap than a green tick over an unparsed file.
      ...(typescriptUnavailable ? ["**/*.ts", "**/*.tsx", "**/*.mts"] : []),
    ],
  },
  js.configs.recommended,
  ...typescriptConfigs,
  {
    // Every .mjs in this repo is a node script (browser code is .ts/.tsx
    // under packages/admin-ui), so they all get node globals.
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        fetch: "readonly",
      },
    },
  },
];
