#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { lexicalRetriever, runBenchmark } from "./index.js";
import type { BenchmarkFixture } from "./types.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const fixturePath = arg("--fixture") ?? arg("-f");
  if (!fixturePath) throw new Error("Usage: novamem-bench --fixture <fixture.json> [--out report.json]");
  const fixture = JSON.parse(readFileSync(resolve(fixturePath), "utf8")) as BenchmarkFixture;
  const report = await runBenchmark(fixture, lexicalRetriever);
  const output = JSON.stringify(report, null, 2);
  const out = arg("--out") ?? arg("-o");
  if (out) writeFileSync(resolve(out), `${output}\n`);
  else console.log(output);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
