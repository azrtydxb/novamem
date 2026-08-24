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
// 7.0.2); support is tracked in typescript-eslint#10940. Importing it
// unconditionally threw for EVERY file, JavaScript included — so it is
// loaded defensively. When a release supports TS 7, TypeScript linting
// switches on here with no further change.
let typescriptConfigs = [];
let typescriptUnavailable = null;
try {
  const tseslint = (await import("typescript-eslint")).default;
  typescriptConfigs = tseslint.configs.recommended;
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
