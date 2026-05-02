/**
 * Service entry point. Wires the engine, transports, and the decay loop, and
 * exposes a clean shutdown path.
 */

import { ColdStore } from "./cold-store.js";
import { GraphStore } from "./graph-store.js";
import { WarmStore } from "./warm-store/index.js";
import { MemoryEngine } from "./engine/index.js";
import { makeEmbedder } from "./embeddings.js";
import { buildHttpServer } from "./http.js";
import { loadConfig } from "./config.js";
import { MetricsCollector } from "./admin/metrics.js";
import { bootstrapAdmin, gcExpiredSessions } from "./auth.js";

async function main() {
  const cfg = loadConfig();

  if (cfg.auth.mode === "none") {
    // Loud, unmissable: a docker-compose default with no auth is fine for
    // local dev but a footgun in production. The default exists so the
    // service "just works" out of the box; this warning is the receipt.
    // eslint-disable-next-line no-console
    console.warn(
      "[novamem] WARNING: auth.mode=none — every request is accepted as the 'public' tenant. " +
        "Set NOVAMEM_AUTH_MODE=tenant + NOVAMEM_ADMIN_TOKEN for real isolation, " +
        "or =bearer + NOVAMEM_AUTH_TOKEN for a shared single-tenant token.",
    );
  } else if (cfg.auth.mode === "bearer") {
    // Bearer mode is fine for single-tenant deployments but doesn't isolate.
    // eslint-disable-next-line no-console
    console.warn(
      "[novamem] auth.mode=bearer — single shared token, single 'public' tenant. " +
        "Use auth.mode=tenant for multi-tenant isolation.",
    );
  }

  const warm = new WarmStore({ url: cfg.warm.url });
  await warm.initialize();

  // Seed the bootstrap admin if there are no users and the env vars are set.
  // Keeps the first-deploy "set env, restart, log in" path zero-touch.
  await bootstrapAdmin(
    warm,
    process.env.NOVAMEM_BOOTSTRAP_ADMIN_USERNAME,
    process.env.NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD,
    {
      info: (m) => console.log(m), // eslint-disable-line no-console
      warn: (m) => console.warn(m), // eslint-disable-line no-console
    },
  );

  const cold = new ColdStore({ url: cfg.cold.url, vectorSize: cfg.cold.vectorSize });

  const graph = cfg.graph.enabled && cfg.graph.url ? new GraphStore({ url: cfg.graph.url }) : null;
  if (graph) await graph.connect();

  const embedder = makeEmbedder({
    provider: cfg.embeddings.provider,
    endpoint: cfg.embeddings.endpoint,
    model: cfg.embeddings.model,
    apiKey: cfg.embeddings.apiKey,
    dimensions: cfg.embeddings.dimensions,
  });

  const metrics = new MetricsCollector();
  metrics.bindGaugeSources({
    warmEntries: async () => {
      const r = await warm.pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM memory_entries WHERE cold = false",
      );
      return Number(r.rows[0]?.count ?? 0);
    },
    coldEntries: async () => {
      const r = await warm.pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM memory_entries WHERE cold = true",
      );
      return Number(r.rows[0]?.count ?? 0);
    },
    graphEdges: async () => (graph ? graph.edgeCount() : null),
    orphansPending: async () => {
      const r = await warm.pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM cold_orphans",
      );
      return Number(r.rows[0]?.count ?? 0);
    },
  });

  metrics.bindTenantGaugeSources({
    warmEntries: async (tenantId) => {
      const r = await warm.pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM memory_entries WHERE tenant_id = $1 AND cold = false",
        [tenantId],
      );
      return Number(r.rows[0]?.count ?? 0);
    },
    coldEntries: async (tenantId) => {
      const r = await warm.pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM memory_entries WHERE tenant_id = $1 AND cold = true",
        [tenantId],
      );
      return Number(r.rows[0]?.count ?? 0);
    },
    graphEdges: async (_tenantId) => {
      // Per-tenant edge count would require a graph query parameterised on
      // tenant — out of scope for this dashboard cut. Return null so the UI
      // shows "—" for tenant-scoped graph edges.
      return null;
    },
  });

  const engine = new MemoryEngine({
    warm,
    cold,
    graph,
    embedder,
    defaultEffectiveDays: cfg.decay.defaultEffectiveDays,
    metrics,
  });

  // P1-S4: daily session GC sweep. Sessions don't slide; expired rows
  // would otherwise accumulate forever.
  const sessionGcTimer = setInterval(async () => {
    try {
      const n = await gcExpiredSessions(warm);
      if (n > 0) {
        // eslint-disable-next-line no-console
        console.log(`[novamem] gc-expired-sessions: ${n} rows removed`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("session GC failed", err);
    }
  }, 24 * 60 * 60 * 1000);
  // Don't keep the process alive just for the GC timer.
  sessionGcTimer.unref?.();

  const decayTimer = setInterval(async () => {
    try {
      await engine.decay();
      // Run the cold-orphan reaper on the same cadence — both touch cold
      // storage and there's no value in running them at different rates.
      const reap = await engine.reapOrphans();
      if (reap.attempted > 0) {
        // eslint-disable-next-line no-console
        console.log(`[novamem] reaped orphans:`, reap);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("decay/reap loop error", err);
    }
  }, cfg.decay.intervalMs);

  const app = buildHttpServer({
    engine,
    warm,
    auth: cfg.auth,
    rateLimitPerMinute: cfg.service.rateLimitPerMinute,
    metrics,
    adminDashboard: cfg.admin.dashboard,
  });
  await app.listen({ host: cfg.service.host, port: cfg.service.port });

  // eslint-disable-next-line no-console
  console.log(`[novamem] listening on ${cfg.service.host}:${cfg.service.port}`);

  const shutdown = async () => {
    clearInterval(decayTimer);
    clearInterval(sessionGcTimer);
    await app.close();
    if (graph) await graph.close();
    await warm.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
