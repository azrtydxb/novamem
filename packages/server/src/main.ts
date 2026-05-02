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

async function main() {
  const cfg = loadConfig();

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

  const engine = new MemoryEngine({
    warm,
    cold,
    graph,
    embedder,
    defaultEffectiveDays: cfg.decay.defaultEffectiveDays,
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

  const app = buildHttpServer({ engine, auth: cfg.auth, rateLimitPerMinute: cfg.service.rateLimitPerMinute });
  await app.listen({ host: cfg.service.host, port: cfg.service.port });

  // eslint-disable-next-line no-console
  console.log(`[novamem] listening on ${cfg.service.host}:${cfg.service.port}`);

  const shutdown = async () => {
    clearInterval(decayTimer);
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
