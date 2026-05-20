import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildHttpServer } from "../dist/http.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const out = resolve(here, "..", "..", "..", "docs", "api", "openapi.json");

const noop = async () => ({});
const engine = {
  health: async () => ({ ok: true, deps: { warm: "ok", cold: "ok", graph: "ok" } }),
  adoptionReport: noop,
  hygieneReport: noop,
  evaluateMemoryQuality: noop,
  search: noop,
  context: noop,
  capture: noop,
  sessionRecap: noop,
  remember: noop,
  decay: noop,
  dreamCycle: noop,
  update: noop,
  reapOrphans: noop,
  recent: noop,
  neighbors: noop,
  forget: noop,
  stats: noop,
};
const warm = {
  resolveUserToken: async () => undefined,
  resolveSession: async () => undefined,
  rotateUserToken: async () => undefined,
  listTokensCreatedByUser: async () => [],
  listUserTokens: async () => [],
  createUserToken: async () => undefined,
  deleteUserTokenByHash: async () => false,
  listProjectsForUser: async () => [],
  createProject: async () => undefined,
  deleteProject: async () => false,
  listProjectMembers: async () => [],
  addProjectMemberByEmail: async () => undefined,
  removeProjectMember: async () => false,
  getActiveProject: async () => null,
  setActiveProject: async () => undefined,
  clearActiveProject: async () => undefined,
  todayForUser: async () => ({}),
  getOnboarding: async () => ({}),
};
const metrics = {
  snapshot: async () => ({}),
  snapshotForUser: async () => ({}),
  prometheus: async () => "",
  record: () => undefined,
  forgetToken: () => undefined,
};
const betterAuth = {
  handler: async () => new Response("not implemented", { status: 501 }),
  getSession: async () => null,
};

const app = buildHttpServer({
  engine,
  warm,
  metrics,
  betterAuth,
  auth: { mode: "none" },
  adminDashboard: true,
  rateLimitPerMinute: 100000,
  logLevel: "silent",
});

await app.ready();
writeFileSync(out, JSON.stringify(app.swagger(), null, 2) + "\n");
await app.close();
console.log("wrote", out);
