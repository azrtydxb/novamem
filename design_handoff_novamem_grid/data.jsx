// Shared mock data for all three directions
// Realistic numbers and structures aligned with the NovaMem README

window.NM_DATA = {
  user: {
    username: "akiyo",
    role: "user", // "admin" or "user"
    tenantId: "acme",
    tenantName: "Acme Corp",
  },
  admin: {
    username: "root",
    role: "admin",
    tenantId: null,
  },
  metrics: {
    counters: {
      queries_total: 248_731,
      queries_zero_hit: 1_842,
      remembers_total: 67_480,
      forgets_total: 312,
      promotions_total: 3_847,
      demotions_total: 1_206,
      decay_runs_total: 184,
      orphans_reaped_total: 27,
      hits_warm_total: 168_204,
      hits_cold_total: 71_338,
      hits_graph_total: 28_960,
    },
    gauges: {
      warm_entries: 12_847,
      cold_entries: 38_204,
      graph_edges: 41_938,
      orphans_pending: 3,
      last_decay_run_iso: "2026-05-02T08:42:11.000Z",
    },
    rates: {
      queries_per_sec_60s: 4.7,
      remembers_per_sec_60s: 1.2,
    },
    uptime_ms: 86_400_000 * 14,
  },
  // 60 points of fake throughput history (queries/s, remembers/s)
  history: Array.from({ length: 60 }, (_, i) => {
    const t = i / 60;
    const q = 4.5 + Math.sin(t * 6.2) * 1.4 + Math.sin(t * 18) * 0.6 + Math.random() * 0.4;
    const r = 1.1 + Math.sin(t * 4 + 1) * 0.5 + Math.random() * 0.2;
    return { t: i, q: Math.max(0.2, q), r: Math.max(0.1, r) };
  }),
  health: [
    { name: "postgres", role: "warm store", status: "ok", latency_ms: 2, version: "16.2", host: "pg-primary.internal" },
    { name: "qdrant", role: "cold / vector", status: "ok", latency_ms: 8, version: "1.9.1", host: "qdrant-0.internal" },
    { name: "falkordb", role: "graph", status: "degraded", latency_ms: 412, version: "4.0.6", host: "falkor.internal" },
    { name: "embedder", role: "transformers (local)", status: "ok", latency_ms: 31, version: "xenova/all-MiniLM", host: "in-process" },
  ],
  tenants: [
    { id: "acme", name: "Acme Corp", users: 12, tokens: 34, memories: 12_847, created: "2025-09-12" },
    { id: "globex", name: "Globex", users: 4, tokens: 9, memories: 2_103, created: "2025-11-04" },
    { id: "initech", name: "Initech", users: 28, tokens: 87, memories: 84_209, created: "2025-06-30" },
    { id: "soylent", name: "Soylent", users: 2, tokens: 3, memories: 412, created: "2026-02-18" },
    { id: "public", name: "public (default)", users: 0, tokens: 1, memories: 38, created: "2025-04-01" },
  ],
  users: [
    { id: 1, username: "root", role: "admin", tenantId: null, lastSeen: "2m ago" },
    { id: 2, username: "akiyo", role: "user", tenantId: "acme", lastSeen: "just now" },
    { id: 3, username: "marcus", role: "user", tenantId: "acme", lastSeen: "21m ago" },
    { id: 4, username: "yuki", role: "user", tenantId: "globex", lastSeen: "3h ago" },
    { id: 5, username: "petra", role: "admin", tenantId: null, lastSeen: "yesterday" },
    { id: 6, username: "bob", role: "user", tenantId: "initech", lastSeen: "5d ago" },
  ],
  projects: [
    {
      id: "phoenix", name: "Phoenix", role: "owner",
      memories: 4_812, members: 6, tokens: 4, sharedAcrossTenants: true,
      lastActivity: "12m ago",
    },
    {
      id: "atlas", name: "Atlas Migration", role: "owner",
      memories: 1_204, members: 3, tokens: 2, sharedAcrossTenants: false,
      lastActivity: "1h ago",
    },
    {
      id: "jade-research", name: "Jade Research", role: "member",
      memories: 18_409, members: 12, tokens: 0, sharedAcrossTenants: true,
      lastActivity: "yesterday",
    },
  ],
  tokens: [
    { id: "t1", label: "macbook-pro-14", scope: "tenant: acme", hash: "8af2…d4e1", lastUsed: "3m ago", created: "2026-04-02", uses_24h: 2_847 },
    { id: "t2", label: "phoenix-laptop", scope: "project: phoenix", hash: "2c91…7b03", lastUsed: "12m ago", created: "2026-04-18", uses_24h: 1_204 },
    { id: "t3", label: "ci-runner-prod", scope: "tenant: acme", hash: "f117…9a0e", lastUsed: "1h ago", created: "2026-03-21", uses_24h: 18_402 },
    { id: "t4", label: "atlas-cli", scope: "project: atlas", hash: "60a8…1f2c", lastUsed: "2d ago", created: "2026-02-10", uses_24h: 0 },
  ],
  // Memory entries (synthesized)
  memories: [
    { id: "m_8a3f", content: "User prefers dark roast espresso, 1:2 ratio. Avoid filter coffee.", project: "phoenix", namespace: "preferences", hits: 47, age: "12d", tier: "warm", decay: 0.94, score: 0.881 },
    { id: "m_2c91", content: "Phoenix sprint 14 retro: shipped vector backend, 18% latency win on cold reads.", project: "phoenix", namespace: "default", hits: 12, age: "3d", tier: "warm", decay: 0.81, score: 0.812 },
    { id: "m_f117", content: "Atlas migration plan: cutover scheduled for May 18 maintenance window. DBA on-call: marcus.", project: "atlas", namespace: "default", hits: 31, age: "8d", tier: "warm", decay: 0.88, score: 0.794 },
    { id: "m_60a8", content: "FalkorDB query timeout at 400ms — confirmed not a network issue, falkor instance OOM under load.", project: "phoenix", namespace: "incidents", hits: 8, age: "21d", tier: "cold", decay: 0.41, score: 0.722 },
    { id: "m_7b03", content: "Decision: stick with min-max-normalized weighted fusion over RRF. Better tail behavior at k>20.", project: "phoenix", namespace: "decisions", hits: 22, age: "45d", tier: "cold", decay: 0.62, score: 0.701 },
    { id: "m_9a0e", content: "Library: @xenova/transformers handles 384-dim MiniLM L6 v2 in <40ms on M1.", project: null, namespace: "default", hits: 4, age: "67d", tier: "cold", decay: 0.28, score: 0.654 },
    { id: "m_d4e1", content: "Marcus is on PTO May 4–11. Ping yuki for atlas review during that window.", project: "atlas", namespace: "team", hits: 3, age: "2d", tier: "warm", decay: 0.71, score: 0.612 },
  ],
  graph: {
    // node positions are normalized 0..1
    nodes: [
      { id: "m_8a3f", x: 0.50, y: 0.50, hits: 47, tier: "warm", label: "espresso prefs" },
      { id: "m_2c91", x: 0.30, y: 0.32, hits: 12, tier: "warm", label: "sprint 14 retro" },
      { id: "m_f117", x: 0.72, y: 0.36, hits: 31, tier: "warm", label: "atlas cutover" },
      { id: "m_7b03", x: 0.18, y: 0.62, hits: 22, tier: "cold", label: "fusion decision" },
      { id: "m_60a8", x: 0.80, y: 0.66, hits: 8,  tier: "cold", label: "falkor OOM" },
      { id: "m_d4e1", x: 0.42, y: 0.78, hits: 3,  tier: "warm", label: "marcus PTO" },
      { id: "m_9a0e", x: 0.62, y: 0.18, hits: 4,  tier: "cold", label: "minilm 384d" },
      { id: "m_aaa1", x: 0.10, y: 0.30, hits: 1,  tier: "cold", label: "qdrant tuning" },
      { id: "m_bbb2", x: 0.88, y: 0.50, hits: 14, tier: "warm", label: "yuki on-call" },
    ],
    edges: [
      ["m_8a3f","m_2c91", 0.82], ["m_8a3f","m_f117", 0.61], ["m_8a3f","m_d4e1", 0.44],
      ["m_2c91","m_7b03", 0.71], ["m_2c91","m_9a0e", 0.55],
      ["m_f117","m_60a8", 0.78], ["m_f117","m_bbb2", 0.66], ["m_f117","m_d4e1", 0.52],
      ["m_60a8","m_bbb2", 0.48], ["m_7b03","m_aaa1", 0.40],
      ["m_d4e1","m_bbb2", 0.31],
    ],
  },
  // 'today' timeline events
  today: [
    { t: "08:42:11", kind: "decay", text: "Decay pass: demoted 41, promoted 12, reaped 0 orphans." },
    { t: "09:14:02", kind: "remember", text: "remember(\"User prefers dark roast espresso…\") → m_8a3f", project: "phoenix" },
    { t: "10:01:33", kind: "search", text: "search(\"sprint 14\", k=5) → 5 hits, 3 warm, 2 cold", project: "phoenix" },
    { t: "10:18:50", kind: "share", text: "Project atlas: added member yuki@globex (cross-tenant)", project: "atlas" },
    { t: "11:04:21", kind: "token", text: "Token minted: phoenix-laptop · scope project:phoenix", project: "phoenix" },
    { t: "11:47:08", kind: "remember", text: "remember(\"FalkorDB query timeout at 400ms…\") → m_60a8", project: "phoenix" },
    { t: "12:30:00", kind: "decay", text: "Decay pass: demoted 18, promoted 4." },
    { t: "13:12:44", kind: "search", text: "search(\"atlas cutover\", project=atlas, k=10) → 4 hits", project: "atlas" },
    { t: "14:02:11", kind: "forget", text: "forget(m_xxx7) — explicit deletion across warm+cold+graph" },
  ],
};
