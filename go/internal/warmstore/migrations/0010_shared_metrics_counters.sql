-- Lifetime counters, summed across replicas.
--
-- The collector's counters are per-process and in-memory, so with more
-- than one replica the dashboard showed whichever pod the request landed
-- on: six consecutive reads of /v1/me/metrics on a three-replica
-- deployment returned decay_runs_total of 1/1/1/0/0/0. Each replica now
-- flushes its delta here once a minute and the snapshot reads the sum,
-- the same additive-upsert pattern metrics_samples already uses for the
-- 24h chart.
--
-- Persisting them also ends the "resets on restart" behaviour: a total
-- that forgets itself on every deploy is not a total.
CREATE TABLE IF NOT EXISTS "metrics_counters" (
	"name" text PRIMARY KEY NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL
);
