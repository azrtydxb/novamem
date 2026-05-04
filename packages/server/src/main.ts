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
import { buildAuth } from "./auth-betterauth.js";

async function main() {
  const cfg = loadConfig();

  if (cfg.auth.mode === "none") {
    // Loud, unmissable: a docker-compose default with no auth is fine for
    // local dev but a footgun in production. The default exists so the
    // service "just works" out of the box; this warning is the receipt.
    // eslint-disable-next-line no-console
    console.warn(
      "[novamem] WARNING: auth.mode=none — every request is accepted as the 'public' user. " +
        "Set NOVAMEM_AUTH_MODE=user for real isolation, " +
        "or =bearer + NOVAMEM_AUTH_TOKEN for a shared single-user bearer.",
    );
  } else if (cfg.auth.mode === "bearer") {
    // Bearer mode is fine for single-user deployments but doesn't isolate.
    // eslint-disable-next-line no-console
    console.warn(
      "[novamem] auth.mode=bearer — single shared token, single 'public' user. " +
        "Use auth.mode=user for multi-user isolation.",
    );
  }

  const warm = new WarmStore({ url: cfg.warm.url });
  await warm.initialize();

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

  metrics.bindUserGaugeSources({
    warmEntries: async (userId) => {
      const r = await warm.pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM memory_entries WHERE user_id = $1 AND cold = false",
        [userId],
      );
      return Number(r.rows[0]?.count ?? 0);
    },
    coldEntries: async (userId) => {
      const r = await warm.pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM memory_entries WHERE user_id = $1 AND cold = true",
        [userId],
      );
      return Number(r.rows[0]?.count ?? 0);
    },
    graphEdges: async (_userId) => {
      // Per-user edge count would require a graph query parameterised on
      // user — out of scope for this dashboard cut. Return null so the UI
      // shows "—" for user-scoped graph edges.
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

  // Dream cycle — periodic compaction. Runs daily at the same cadence
  // as decay (the heavy work is the per-entry vector lookup; we don't
  // want to fire it more often than once per cold-store-write batch).
  // No-op on small stores, useful on large ones.
  const dreamTimer = setInterval(async () => {
    try {
      const r = await engine.dreamCycle();
      if (r.merged > 0 || r.edgesPromoted > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[novamem] dream cycle: walked=${r.walked} merged=${r.merged} ` +
            `edgesPromoted=${r.edgesPromoted} durationMs=${r.durationMs}`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("dream cycle error", err);
    }
  }, 24 * 60 * 60 * 1000);
  dreamTimer.unref?.();

  // 24h persistent throughput: every minute, flush pending per-user
  // counters from the in-mem MetricsCollector to metrics_samples so the
  // history chart survives reboots. Same loop also prunes >25h-old rows
  // so the table can't grow without bound.
  const metricsFlushTimer = setInterval(async () => {
    try {
      // Floor sampledAt to the minute so the bucket is stable across
      // races between record() and drain().
      const now = new Date();
      now.setSeconds(0, 0);
      const samples = metrics.drainPendingSamples(now);
      if (samples.length > 0) await warm.recordMetricsSamples(samples);
      // Keep ~25h of history (24h chart + a margin) so a chart query at
      // sample-time-minus-24h always finds a left edge.
      const cutoff = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await warm.pruneMetricsSamples(cutoff);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("metrics flush error", err);
    }
  }, 60 * 1000);
  metricsFlushTimer.unref?.();

  // Better Auth instance — owns the dashboard control plane (login,
  // sessions, JWT issuance). Phase 1: scaffolded alongside the existing
  // /v1/auth/* routes; both flows live until the SPA cuts over.
  const baseUrl = process.env.NOVAMEM_BASE_URL ?? `http://${cfg.service.host}:${cfg.service.port}`;
  const baSecret = process.env.NOVAMEM_COOKIE_SECRET ?? "novamem-dev-cookie-secret-change-me";
  const ba = buildAuth({
    pool: warm.pool,
    baseUrl,
    secret: baSecret,
    secureCookies: process.env.NOVAMEM_INSECURE_COOKIES !== "1",
    trustedOrigins: [baseUrl, "http://localhost:5173"],
  });

  // Bootstrap admin via Better Auth — sign up an account with the
  // configured bootstrap email + password if no Better Auth users exist
  // yet. Idempotent: re-runs on every start but no-ops once an account
  // is present. Better Auth's admin plugin can promote a user via
  // setRole; we do that immediately after sign-up so the dashboard's
  // role-gated routes work on the first login.
  try {
    const adminEmail =
      process.env.NOVAMEM_BOOTSTRAP_ADMIN_EMAIL ??
      process.env.NOVAMEM_BOOTSTRAP_ADMIN_USERNAME ?? null;
    const adminPassword = process.env.NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD ?? null;
    if (adminEmail && adminPassword) {
      // Seed when the system has no admin yet — even if regular users
      // already exist. Admin is the operator account (user management +
      // health checks); regular users sign in for memory operations.
      const probe = await warm.pool.query<{ count: string }>(
        `SELECT count(*)::text FROM "user" WHERE role = 'admin'`,
      );
      const adminCount = Number(probe.rows[0]?.count ?? "0");
      if (adminCount === 0) {
        // Treat the env value as an email when it contains '@', else
        // synthesise a placeholder domain so Better Auth's email-format
        // validator accepts it. Operators get a sensible default for
        // username-style identifiers (legacy "admin" → admin@local).
        const email = adminEmail.includes("@") ? adminEmail : `${adminEmail}@local`;
        const r = await ba.api.signUpEmail({
          body: {
            email,
            password: adminPassword,
            name: adminEmail,
          },
        });
        const newUserId = (r as { user?: { id?: string } } | undefined)?.user?.id;
        if (newUserId) {
          // Promote the bootstrap user to admin. Better Auth's
          // /admin/set-role endpoint requires admin auth — and we're
          // the only user in the system right now, so there's no admin
          // to make the call. Direct DB UPDATE is the documented escape
          // hatch for the bootstrap case.
          await warm.pool.query(
            `UPDATE "user" SET role = 'admin', "updatedAt" = now() WHERE id = $1`,
            [newUserId],
          );
          // eslint-disable-next-line no-console
          console.log(`[novamem] seeded bootstrap admin "${email}" via Better Auth`);
        }
        // Scrub the bootstrap password from the env so docker inspect
        // can't recover it for the lifetime of the process.
        delete process.env.NOVAMEM_BOOTSTRAP_ADMIN_PASSWORD;
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[novamem] bootstrap admin failed:", (err as Error).message);
  }

  const app = buildHttpServer({
    engine,
    warm,
    auth: cfg.auth,
    rateLimitPerMinute: cfg.service.rateLimitPerMinute,
    metrics,
    adminDashboard: cfg.admin.dashboard,
    betterAuth: {
      handler: (req) => ba.handler(req),
      getSession: (headers) => ba.api.getSession({ headers }) as Promise<{ user?: { id: string }; session?: { id: string } } | null>,
    },
  });
  await app.listen({ host: cfg.service.host, port: cfg.service.port });

  // eslint-disable-next-line no-console
  console.log(`[novamem] listening on ${cfg.service.host}:${cfg.service.port}`);

  const shutdown = async () => {
    clearInterval(decayTimer);
    clearInterval(dreamTimer);
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
