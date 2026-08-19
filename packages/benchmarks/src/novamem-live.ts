import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runBenchmark } from "./runner.js";
import { benchmarkFixtureSchema } from "./schema.js";
import { toComparableMemoryBenchmarkReport } from "./comparable-report.js";
import type {
  BenchmarkFixture,
  BenchmarkQuery,
  RetrievedMemory,
  Retriever,
} from "./types.js";

interface LiveOptions {
  baseUrl: string;
  token: string;
  project?: string;
  createProject: boolean;
  cleanup: boolean;
  namespace: string;
}

async function request(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown
): Promise<any> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok)
    throw new Error(
      `${method} ${path} failed HTTP ${response.status}: ${text.slice(0, 300)}`
    );
  return parsed;
}

function extractSearchResults(
  payload: any
): Array<{ id: string; content?: string; score?: number }> {
  const rows = Array.isArray(payload?.results)
    ? payload.results
    : Array.isArray(payload)
    ? payload
    : [];
  return rows.map((r: any) => ({
    id: String(r.id),
    content: r.content ?? r.text,
    score: typeof r.score === "number" ? r.score : undefined,
  }));
}

async function createBenchmarkProject(
  fixture: BenchmarkFixture,
  opts: LiveOptions
): Promise<{ project: string; created: boolean }> {
  if (opts.createProject) {
    const created = await request(
      opts.baseUrl,
      opts.token,
      "POST",
      "/v1/me/projects",
      { name: opts.project ?? `bench-${fixture.name}-${Date.now()}` }
    );
    return { project: String(created.id), created: true };
  }
  if (!opts.project)
    throw new Error("live benchmark requires --project or --create-project");
  return { project: opts.project, created: false };
}

async function cleanupSeededMemories(
  opts: LiveOptions & { project: string },
  ids: string[]
): Promise<string[]> {
  const failures: string[] = [];
  for (const id of ids) {
    try {
      await request(opts.baseUrl, opts.token, "POST", "/v1/forget", {
        id,
        project: opts.project,
      });
    } catch (err) {
      failures.push(
        `${id}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return failures;
}

export async function seedFixtureIntoNovaMem(
  fixture: BenchmarkFixture,
  opts: LiveOptions & { project: string }
): Promise<{ project: string; idMap: Map<string, string> }> {
  const idMap = new Map<string, string>();
  for (const memory of [...fixture.memories].sort((a, b) => {
    const as = a.supersededBy ? 0 : 1;
    const bs = b.supersededBy ? 0 : 1;
    return as - bs;
  })) {
    const stored = await request(
      opts.baseUrl,
      opts.token,
      "POST",
      "/v1/capture",
      {
        content: `[bench:${memory.id}] ${memory.text}`,
        namespace: opts.namespace,
        project: opts.project,
        force: true,
        metadata: {
          benchmarkFixture: fixture.name,
          benchmarkMemoryId: memory.id,
          ...(memory.metadata ?? {}),
        },
        sourceType: "benchmark",
        source: "novamem-benchmarks",
      }
    );
    idMap.set(memory.id, String(stored.id));
  }
  return { project: opts.project, idMap };
}

export function makeNovaMemRetriever(
  opts: LiveOptions & { project: string; idMap: Map<string, string> }
): Retriever {
  const reverse = new Map(
    [...opts.idMap.entries()].map(([fixtureId, storedId]) => [
      storedId,
      fixtureId,
    ])
  );
  return async (
    query: BenchmarkQuery,
    _fixture,
    { k }
  ): Promise<RetrievedMemory[]> => {
    const payload = await request(
      opts.baseUrl,
      opts.token,
      "POST",
      "/v1/search",
      {
        query: query.text,
        k,
        namespace: opts.namespace,
        project: opts.project,
        maxSensitivity: "sensitive",
      }
    );
    return extractSearchResults(payload).map((r) => {
      const fixtureId =
        reverse.get(r.id) ??
        /\[bench:([^\]]+)\]/.exec(r.content ?? "")?.[1] ??
        r.id;
      return {
        id: fixtureId,
        text: r.content,
        score: r.score,
        answer:
          query.expectedAnswer &&
          (r.content ?? "")
            .toLowerCase()
            .includes(query.expectedAnswer.toLowerCase())
            ? query.expectedAnswer
            : undefined,
      };
    });
  };
}

export async function runLiveNovaMemBenchmark(
  fixture: BenchmarkFixture,
  opts: LiveOptions,
  kValues?: number[]
) {
  const projectState = await createBenchmarkProject(fixture, opts);
  const liveOpts = { ...opts, project: projectState.project };
  let idMap = new Map<string, string>();
  const cleanupFailures: string[] = [];
  try {
    const seeded = await seedFixtureIntoNovaMem(fixture, liveOpts);
    idMap = seeded.idMap;
    const report = await runBenchmark(
      fixture,
      makeNovaMemRetriever({ ...liveOpts, idMap }),
      { kValues }
    );
    return {
      ...report,
      live: {
        project: projectState.project,
        cleanup: opts.cleanup,
        cleanupFailures,
      },
    };
  } finally {
    if (opts.cleanup) {
      if (projectState.created) {
        try {
          await request(
            opts.baseUrl,
            opts.token,
            "DELETE",
            `/v1/me/projects/${encodeURIComponent(projectState.project)}`
          );
        } catch (err) {
          cleanupFailures.push(
            `project ${projectState.project}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      } else {
        cleanupFailures.push(
          ...(await cleanupSeededMemories(liveOpts, [...idMap.values()]))
        );
      }
      if (cleanupFailures.length > 0) {
        throw new Error(
          `live benchmark cleanup failed: ${cleanupFailures.join("; ")}`
        );
      }
    }
  }
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function parseCutoffs(value?: string): number[] {
  return value
    ? value
        .split(",")
        .map((v) => Number.parseInt(v.trim(), 10))
        .filter(Number.isFinite)
    : [10, 20, 50, 200];
}

export async function liveCliMain(argv = process.argv) {
  const fixturePath = arg(argv, "--fixture") ?? arg(argv, "-f");
  const baseUrl =
    arg(argv, "--base-url") ??
    process.env.NOVAMEM_BASE_URL ??
    "http://localhost:7778";
  const token = arg(argv, "--token") ?? process.env.NOVAMEM_TOKEN;
  if (!fixturePath || !token)
    throw new Error(
      "Usage: novamem-bench-live --fixture <fixture.json> --token <token> [--base-url URL] [--create-project] [--cleanup] [--format internal|comparable]"
    );
  const fixture = benchmarkFixtureSchema.parse(
    JSON.parse(readFileSync(resolve(fixturePath), "utf8"))
  ) as BenchmarkFixture;
  const topKCutoffs = parseCutoffs(arg(argv, "--top-k-cutoffs"));
  const report = await runLiveNovaMemBenchmark(
    fixture,
    {
      baseUrl,
      token,
      project: arg(argv, "--project"),
      createProject: argv.includes("--create-project"),
      cleanup: argv.includes("--cleanup"),
      namespace: arg(argv, "--namespace") ?? `benchmark-${Date.now()}`,
    },
    topKCutoffs
  );
  const format = arg(argv, "--format") ?? "internal";
  const payload =
    format === "comparable"
      ? toComparableMemoryBenchmarkReport(report, {
          projectName: arg(argv, "--project-name") ?? fixture.name,
          runId: arg(argv, "--run-id"),
          answererModel:
            arg(argv, "--answerer-model") ?? "novamem-search-answer",
          judgeModel: arg(argv, "--judge-model") ?? "exact-match-token-f1",
          provider: arg(argv, "--provider") ?? "novamem-live",
          topKCutoffs,
        })
      : report;
  const output = JSON.stringify(payload, null, 2);
  const out = arg(argv, "--out") ?? arg(argv, "-o");
  if (out) writeFileSync(resolve(out), `${output}\n`);
  else console.log(output);
}
