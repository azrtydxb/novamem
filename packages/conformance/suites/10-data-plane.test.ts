import { afterAll, describe, expect, it } from "vitest";
import { api, ns } from "../src/client.js";
import {
  ErrorBody,
  ForgetResponse,
  MemoryEntry,
  RecentResponse,
  RememberResponse,
  StatsResponse,
  UpdateMemoryResponse,
} from "../src/schemas.js";

const NS = ns();
const createdIds: string[] = [];

describe("data plane CRUD", () => {
  let id: string;

  it("remember stores and returns an entry id", async () => {
    const r = await api<unknown>("/v1/remember", {
      body: { content: `conformance fact ${NS}`, namespace: NS },
    });
    expect(r.status).toBe(201);
    const parsed = RememberResponse.parse(r.body);
    expect(parsed.id).toBeTruthy();
    id = parsed.id as string;
    createdIds.push(id);
  });

  it("recent lists it", async () => {
    const r = await api<unknown>("/v1/recent", {
      body: { namespace: NS, k: 10 },
    });
    expect(r.status).toBe(200);
    const parsed = RecentResponse.parse(r.body);
    const entries = parsed.results.map((e) => MemoryEntry.parse(e));
    expect(entries.some((e) => e.id === id)).toBe(true);
  });

  it("PUT /v1/memories/:id updates content; recent reflects the change", async () => {
    const newContent = `conformance fact ${NS} (updated)`;
    const r = await api<unknown>(`/v1/memories/${id}`, {
      method: "PUT",
      body: { content: newContent },
    });
    expect(r.status).toBe(200);
    const parsed = UpdateMemoryResponse.parse(r.body);
    expect(parsed.id).toBe(id);
    expect(parsed.updated).toBe(true);

    const recent = await api<unknown>("/v1/recent", {
      body: { namespace: NS, k: 10 },
    });
    expect(recent.status).toBe(200);
    const entries = RecentResponse.parse(recent.body).results.map((e) => MemoryEntry.parse(e));
    const updated = entries.find((e) => e.id === id);
    expect(updated?.content).toBe(newContent);
  });

  it("remember with expiresAt honors TTL shape", async () => {
    const r = await api<unknown>("/v1/remember", {
      body: {
        content: `ttl fact ${NS}`,
        namespace: NS,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    });
    expect(r.status).toBe(201);
    const parsed = RememberResponse.parse(r.body);
    expect(parsed.id).toBeTruthy();
    // Response shape carries no `expiresAt` echo (RememberResponse is just
    // `{id, rejected?, deduplicated?, embedded?}`) — the 201 + valid id is
    // the observable contract here.
    if (parsed.id) createdIds.push(parsed.id);
  });

  it("forget deletes; PUT on the forgotten id then 404s", async () => {
    const del = await api<unknown>("/v1/forget", { body: { id } });
    expect(del.status).toBe(200);
    const parsed = ForgetResponse.parse(del.body);
    expect(parsed.deleted).toBe(true);

    const gone = await api<unknown>(`/v1/memories/${id}`, {
      method: "PUT",
      body: { content: "should not apply" },
    });
    expect(gone.status).toBe(404);
    ErrorBody.parse(gone.body);
  });

  it("stats responds with per-namespace counts", async () => {
    // The bench oracle's per-user stats scan can be slow under concurrent
    // suite load (observed >30s), well past vitest's default timeout —
    // give it real headroom rather than flaking the whole run.
    const r = await api<unknown>("/v1/stats");
    expect(r.status).toBe(200);
    StatsResponse.parse(r.body);
  }, 60_000);

  afterAll(async () => {
    // No bulk forget-by-namespace endpoint exists (only POST /v1/forget by
    // id) — loop over everything this suite created that wasn't already
    // forgotten above.
    await Promise.all(
      createdIds
        .filter((entryId) => entryId !== id)
        .map((entryId) => api("/v1/forget", { body: { id: entryId } }).catch(() => {})),
    );
  });
});
