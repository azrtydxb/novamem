#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { lexicalRetriever, runBenchmark, toComparableMemoryBenchmarkReport } from "./index.js";
import type { BenchmarkFixture } from "./types.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

function parseCutoffs(value?: string): number[] {
  return value ? value.split(",").map((v) => Number.parseInt(v.trim(), 10)).filter(Number.isFinite) : [10, 20, 50, 200];
}

async function main() {
  const fixturePath = arg("--fixture") ?? arg("-f");
  if (!fixturePath) throw new Error("Usage: novamem-bench --fixture <fixture.json> [--out report.json] [--format internal|comparable]");
  const fixture = JSON.parse(readFileSync(resolve(fixturePath), "utf8")) as BenchmarkFixture;
  const topKCutoffs = parseCutoffs(arg("--top-k-cutoffs"));
  const report = await runBenchmark(fixture, lexicalRetriever, { kValues: topKCutoffs });
  const format = arg("--format") ?? "internal";
  const payload = format === "comparable"
    ? toComparableMemoryBenchmarkReport(report, {
      projectName: arg("--project-name") ?? fixture.name,
      runId: arg("--run-id"),
      answererModel: arg("--answerer-model") ?? "lexical-baseline",
      judgeModel: arg("--judge-model") ?? "exact-match-token-f1",
      provider: arg("--provider") ?? "offline",
      topKCutoffs,
    })
    : report;
  const output = JSON.stringify(payload, null, 2);
  const out = arg("--out") ?? arg("-o");
  if (out) writeFileSync(resolve(out), `${output}\n`);
  else console.log(output);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
