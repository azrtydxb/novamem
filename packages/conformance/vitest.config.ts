import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    fileParallelism: false, // suites share one live server; run in order
    testTimeout: 30_000,
    include: ["suites/**/*.test.ts"],
  },
});
