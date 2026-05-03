// Direction 3 — GRID
// Modern technical SaaS. JetBrains Mono + Inter. Cool blue-grey. oklch accents.
// Linear/Vercel polish. Sparkline-everywhere. Memory = node graph.

const GR_LIGHT = {
  bg: "#fafbfc",
  panel: "#ffffff",
  subtle: "#f3f5f8",
  ink: "#0d1117",
  dim: "#5b6470",
  faint: "#8b94a3",
  rule: "#e6e9ee",
  ruleSoft: "#eef0f4",
  accent: "oklch(58% 0.15 250)",
  accentSoft: "oklch(95% 0.04 250)",
  warm: "oklch(62% 0.16 35)",
  warmSoft: "oklch(95% 0.04 35)",
  cold: "oklch(58% 0.13 220)",
  coldSoft: "oklch(95% 0.04 220)",
  graph: "oklch(60% 0.16 165)",
  graphSoft: "oklch(95% 0.04 165)",
  err: "oklch(58% 0.20 25)",
  warn: "oklch(70% 0.16 80)",
};
const GR_DARK = {
  bg: "#0a0d12",
  panel: "#11151c",
  subtle: "#161b24",
  ink: "#e6ebf2",
  dim: "#8a93a3",
  faint: "#5a6373",
  rule: "#1f2530",
  ruleSoft: "#171c25",
  accent: "oklch(70% 0.16 250)",
  accentSoft: "oklch(28% 0.10 250)",
  warm: "oklch(72% 0.17 35)",
  warmSoft: "oklch(28% 0.10 35)",
  cold: "oklch(72% 0.14 220)",
  coldSoft: "oklch(28% 0.10 220)",
  graph: "oklch(72% 0.16 165)",
  graphSoft: "oklch(28% 0.10 165)",
  err: "oklch(70% 0.20 25)",
  warn: "oklch(78% 0.16 80)",
};
function grTokens(d) { return d ? GR_DARK : GR_LIGHT; }

function GrSpark({ c, data, color, w = 80, h = 22 }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * (h - 4) - 2}`).join(" ");
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <polyline fill="none" stroke={color || c.accent} strokeWidth="1.5" points={pts} />
    </svg>
  );
}

function GrSidebar({ c, active, onChange, user }) {
  const isAdmin = user.role === "admin";
  const adminNav = [["metrics","Metrics","◐"],["health","Health","◇"],["tenants","Tenants","▢"],["users","Users","○"]];
  const userNav = [["metrics","Metrics","◐"],["browse","Browse","≡"],["graph","Graph","✦"],["today","Today","◷"],["projects","Projects","▢"],["tokens","API Tokens","⌘"]];
  const nav = isAdmin ? adminNav : userNav;
  return (
    <div style={{ width: 224, flex: "0 0 224px", borderRight: `1px solid ${c.rule}`, background: c.panel, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "18px 18px 16px", borderBottom: `1px solid ${c.ruleSoft}`, display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 28, height: 28, borderRadius: 8, background: c.accent, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width="18" height="18" viewBox="0 0 24 24"><path d="M4 6 L12 12 M20 6 L12 12 M4 18 L12 12 M20 18 L12 12" stroke="white" strokeWidth="1.4" strokeLinecap="round"/><circle cx="12" cy="12" r="2.6" fill="white"/></svg>
        </div>
        <div>
          <div style={{ fontFamily: "var(--gr-sans)", fontSize: 14, fontWeight: 600, color: c.ink, letterSpacing: "-0.005em" }}>NovaMem</div>
          <div style={{ fontFamily: "var(--gr-mono)", fontSize: 10, color: c.dim }}>{isAdmin ? "admin" : user.tenantId}</div>
        </div>
      </div>
      <div style={{ padding: "10px 8px", flex: 1 }}>
        <div style={{ padding: "6px 10px 4px", fontFamily: "var(--gr-mono)", fontSize: 10, color: c.faint, letterSpacing: "0.10em", textTransform: "uppercase" }}>{isAdmin ? "Operations" : "Workspace"}</div>
        {nav.map(([id, label, glyph]) => {
          const a = id === active;
          return (
            <button key={id} onClick={() => onChange(id)} style={{
              display: "flex", alignItems: "center", gap: 10, width: "100%",
              padding: "7px 10px", borderRadius: 6, border: "none",
              background: a ? c.subtle : "transparent",
              color: a ? c.ink : c.dim, cursor: "pointer", fontFamily: "var(--gr-sans)",
              fontSize: 13, fontWeight: a ? 500 : 400,
            }}>
              <span style={{ width: 14, color: a ? c.accent : c.faint, fontFamily: "var(--gr-mono)", fontSize: 12 }}>{glyph}</span>
              {label}
            </button>
          );
        })}
      </div>
      <div style={{ padding: "12px 14px", borderTop: `1px solid ${c.ruleSoft}`, display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 28, height: 28, borderRadius: 28, background: c.accentSoft, color: c.accent, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--gr-sans)", fontSize: 12, fontWeight: 600 }}>{user.username[0].toUpperCase()}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "var(--gr-sans)", fontSize: 12, color: c.ink, fontWeight: 500 }}>{user.username}</div>
          <div style={{ fontFamily: "var(--gr-mono)", fontSize: 10, color: c.dim }}>{isAdmin ? "admin" : `tenant·${user.tenantId}`}</div>
        </div>
      </div>
    </div>
  );
}

function GrStat({ c, label, value, delta, trend, color }) {
  return (
    <div style={{ background: c.panel, border: `1px solid ${c.rule}`, borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontFamily: "var(--gr-sans)", fontSize: 12, color: c.dim, fontWeight: 500 }}>{label}</div>
        {delta != null ? (
          <span style={{ fontFamily: "var(--gr-mono)", fontSize: 10, color: delta > 0 ? c.graph : c.warm, background: delta > 0 ? c.graphSoft : c.warmSoft, padding: "2px 6px", borderRadius: 4 }}>
            {delta > 0 ? "↑" : "↓"} {Math.abs(delta).toFixed(1)}%
          </span>
        ) : null}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 6 }}>
        <div style={{ fontFamily: "var(--gr-sans)", fontSize: 26, fontWeight: 600, color: color || c.ink, letterSpacing: "-0.02em", fontVariantNumeric: "tabular-nums" }}>{value}</div>
        {trend ? <GrSpark c={c} data={trend} color={color || c.accent} w={72} h={22} /> : null}
      </div>
    </div>
  );
}

function GrAreaChart({ c, data, h = 200 }) {
  const W = 800;
  const max = Math.max(...data.map(d => Math.max(d.q, d.r)));
  const pts = (k) => data.map((d, i) => [(i / (data.length - 1)) * W, h - (d[k] / max) * (h - 30) - 14]);
  const line = (k) => pts(k).map((p, i) => (i === 0 ? "M" : "L") + p.join(" ")).join(" ");
  const area = (k) => line(k) + ` L${W} ${h} L0 ${h} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${h}`} style={{ width: "100%", display: "block" }}>
      <defs>
        <linearGradient id="gr-q" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={c.accent} stopOpacity="0.3" />
          <stop offset="100%" stopColor={c.accent} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="gr-r" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={c.graph} stopOpacity="0.22" />
          <stop offset="100%" stopColor={c.graph} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map(g => <line key={g} x1="0" x2={W} y1={h*g} y2={h*g} stroke={c.ruleSoft} strokeWidth="1" />)}
      <path d={area("r")} fill="url(#gr-r)" />
      <path d={line("r")} fill="none" stroke={c.graph} strokeWidth="1.8" />
      <path d={area("q")} fill="url(#gr-q)" />
      <path d={line("q")} fill="none" stroke={c.accent} strokeWidth="2" />
    </svg>
  );
}

function GrMetrics({ c, user }) {
  const m = window.NM_DATA.metrics;
  const isAdmin = user.role === "admin";
  const totalHits = m.counters.hits_warm_total + m.counters.hits_cold_total + m.counters.hits_graph_total;
  const tier = (n) => (n / totalHits * 100);
  const trendQ = window.NM_DATA.history.map(d => d.q);
  const trendR = window.NM_DATA.history.map(d => d.r);
  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <div style={{ padding: "20px 28px 16px", borderBottom: `1px solid ${c.rule}`, display: "flex", alignItems: "center" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h1 style={{ margin: 0, fontFamily: "var(--gr-sans)", fontSize: 22, fontWeight: 600, color: c.ink, letterSpacing: "-0.02em" }}>Metrics</h1>
            <span style={{ fontFamily: "var(--gr-mono)", fontSize: 10, padding: "2px 8px", borderRadius: 99, background: c.accentSoft, color: c.accent }}>● live · 5 s</span>
            {!isAdmin ? <span style={{ fontFamily: "var(--gr-mono)", fontSize: 10, padding: "2px 8px", borderRadius: 99, background: c.subtle, color: c.dim }}>tenant: {user.tenantId}</span> : null}
          </div>
          <div style={{ fontFamily: "var(--gr-sans)", fontSize: 13, color: c.dim, marginTop: 4 }}>
            {isAdmin ? "Cross-tenant counters, gauges, and rates. In-memory; resets on restart." : "Activity for your tenant only. In-memory; resets on restart."}
          </div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button style={{ border: `1px solid ${c.rule}`, background: c.panel, color: c.ink, fontFamily: "var(--gr-sans)", fontSize: 12, fontWeight: 500, padding: "6px 12px", borderRadius: 6, cursor: "pointer" }}>↻ Refresh</button>
          {isAdmin ? <button style={{ border: `1px solid ${c.accent}`, background: c.accent, color: "white", fontFamily: "var(--gr-sans)", fontSize: 12, fontWeight: 500, padding: "6px 12px", borderRadius: 6, cursor: "pointer" }}>Run decay</button> : null}
        </div>
      </div>

      <div style={{ padding: 20, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <GrStat c={c} label="Queries / sec" value={m.rates.queries_per_sec_60s.toFixed(2)} delta={3.2} trend={trendQ} color={c.accent} />
        <GrStat c={c} label="Remembers / sec" value={m.rates.remembers_per_sec_60s.toFixed(2)} delta={-0.8} trend={trendR} color={c.graph} />
        <GrStat c={c} label="Total queries" value={(m.counters.queries_total/1000).toFixed(1) + "k"} delta={5.4} trend={trendQ.map(x => x*1.2)} />
        <GrStat c={c} label={isAdmin ? "Decay runs" : "Total remembers"} value={isAdmin ? m.counters.decay_runs_total : (m.counters.remembers_total/1000).toFixed(1) + "k"} delta={1.1} trend={trendR.map(x => x + 0.5)} />
      </div>

      <div style={{ padding: "0 20px", display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
        <div style={{ background: c.panel, border: `1px solid ${c.rule}`, borderRadius: 8 }}>
          <div style={{ padding: "14px 18px", borderBottom: `1px solid ${c.ruleSoft}`, display: "flex", alignItems: "center" }}>
            <div>
              <div style={{ fontFamily: "var(--gr-sans)", fontSize: 14, fontWeight: 600, color: c.ink }}>Throughput</div>
              <div style={{ fontFamily: "var(--gr-sans)", fontSize: 12, color: c.dim, marginTop: 2 }}>Last 60 seconds · 5 s buckets</div>
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 14, fontFamily: "var(--gr-mono)", fontSize: 11 }}>
              <span style={{ color: c.accent }}>● queries/s</span>
              <span style={{ color: c.graph }}>● remembers/s</span>
            </div>
          </div>
          <div style={{ padding: 18 }}>
            <GrAreaChart c={c} data={window.NM_DATA.history} h={210} />
          </div>
        </div>

        <div style={{ background: c.panel, border: `1px solid ${c.rule}`, borderRadius: 8 }}>
          <div style={{ padding: "14px 18px", borderBottom: `1px solid ${c.ruleSoft}` }}>
            <div style={{ fontFamily: "var(--gr-sans)", fontSize: 14, fontWeight: 600, color: c.ink }}>Hits per tier</div>
            <div style={{ fontFamily: "var(--gr-sans)", fontSize: 12, color: c.dim, marginTop: 2 }}>Contribution to fused results</div>
          </div>
          <div style={{ padding: 18 }}>
            {[
              ["Warm",  m.counters.hits_warm_total, c.warm],
              ["Cold",  m.counters.hits_cold_total, c.cold],
              ["Graph", m.counters.hits_graph_total, c.graph],
            ].map(([label, v, color]) => {
              const p = tier(v);
              return (
                <div key={label} style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--gr-sans)", fontSize: 12, color: c.ink, marginBottom: 6 }}>
                    <span style={{ fontWeight: 500 }}><span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 8, background: color, marginRight: 8 }} />{label}</span>
                    <span style={{ color: c.dim, fontFamily: "var(--gr-mono)", fontVariantNumeric: "tabular-nums" }}>{v.toLocaleString()} <span style={{ color: c.faint }}>· {p.toFixed(0)}%</span></span>
                  </div>
                  <div style={{ height: 6, background: c.subtle, borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${p}%`, background: color, borderRadius: 3 }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div style={{ padding: "12px 20px", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        <GrStat c={c} label="Warm entries" value={m.gauges.warm_entries.toLocaleString()} color={c.warm} />
        <GrStat c={c} label="Cold entries" value={m.gauges.cold_entries.toLocaleString()} color={c.cold} />
        <GrStat c={c} label="Graph edges" value={m.gauges.graph_edges.toLocaleString()} color={c.graph} />
        <GrStat c={c} label="Orphans pending" value={m.gauges.orphans_pending} color={c.warn} />
      </div>

      {isAdmin ? (
        <div style={{ padding: "0 20px 20px" }}>
          <div style={{ background: c.panel, border: `1px solid ${c.rule}`, borderRadius: 8 }}>
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${c.ruleSoft}` }}>
              <div style={{ fontFamily: "var(--gr-sans)", fontSize: 14, fontWeight: 600, color: c.ink }}>Lifecycle</div>
              <div style={{ fontFamily: "var(--gr-sans)", fontSize: 12, color: c.dim, marginTop: 2 }}>
                Memory transitions and cleanup events · last decay 8:42 am · <span style={{ fontFamily: "var(--gr-mono)" }}>effectiveDays = 7 · log₂(hits + 1)</span>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)" }}>
              {[
                ["Remembers", (m.counters.remembers_total/1000).toFixed(1)+"k", c.ink],
                ["Forgets", m.counters.forgets_total, c.ink],
                ["Promotions ↑", m.counters.promotions_total.toLocaleString(), c.graph],
                ["Demotions ↓", m.counters.demotions_total.toLocaleString(), c.warm],
                ["Reaped", m.counters.orphans_reaped_total, c.dim],
              ].map(([l, v, col], i, arr) => (
                <div key={l} style={{ padding: "16px 18px", borderRight: i < arr.length-1 ? `1px solid ${c.ruleSoft}` : "none" }}>
                  <div style={{ fontFamily: "var(--gr-sans)", fontSize: 11, color: c.dim, fontWeight: 500 }}>{l}</div>
                  <div style={{ fontFamily: "var(--gr-sans)", fontSize: 22, fontWeight: 600, color: col, marginTop: 4, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.015em" }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ padding: "0 20px 20px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={{ background: c.panel, border: `1px solid ${c.rule}`, borderRadius: 8 }}>
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${c.ruleSoft}` }}>
              <div style={{ fontFamily: "var(--gr-sans)", fontSize: 14, fontWeight: 600, color: c.ink }}>My projects</div>
            </div>
            <div>
              {window.NM_DATA.projects.map((p, i, arr) => (
                <div key={p.id} style={{ padding: "12px 18px", display: "flex", alignItems: "center", gap: 12, borderBottom: i < arr.length-1 ? `1px solid ${c.ruleSoft}` : "none" }}>
                  <div style={{ width: 32, height: 32, borderRadius: 8, background: c.accentSoft, color: c.accent, fontFamily: "var(--gr-mono)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>▢</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontFamily: "var(--gr-sans)", fontSize: 13, color: c.ink, fontWeight: 500 }}>{p.name} <span style={{ color: c.faint, fontWeight: 400 }}>· {p.id}</span></div>
                    <div style={{ fontFamily: "var(--gr-mono)", fontSize: 10, color: c.dim, marginTop: 2 }}>{p.role} · {p.members} members{p.sharedAcrossTenants ? " · shared" : ""}</div>
                  </div>
                  <div style={{ textAlign: "right", fontFamily: "var(--gr-mono)", fontSize: 11 }}>
                    <div style={{ color: c.ink, fontVariantNumeric: "tabular-nums" }}>{p.memories.toLocaleString()}</div>
                    <div style={{ color: c.faint, fontSize: 10 }}>{p.lastActivity}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div style={{ background: c.panel, border: `1px solid ${c.rule}`, borderRadius: 8 }}>
            <div style={{ padding: "14px 18px", borderBottom: `1px solid ${c.ruleSoft}` }}>
              <div style={{ fontFamily: "var(--gr-sans)", fontSize: 14, fontWeight: 600, color: c.ink }}>Today</div>
            </div>
            <div>
              {window.NM_DATA.today.slice(-5).reverse().map((e, i, arr) => (
                <div key={i} style={{ padding: "10px 18px", display: "grid", gridTemplateColumns: "60px 70px 1fr", gap: 8, alignItems: "center", borderBottom: i < arr.length - 1 ? `1px solid ${c.ruleSoft}` : "none", fontFamily: "var(--gr-mono)", fontSize: 11 }}>
                  <span style={{ color: c.faint }}>{e.t.slice(0,5)}</span>
                  <span style={{ fontSize: 9, color: c.accent, background: c.accentSoft, padding: "2px 6px", borderRadius: 99, textAlign: "center", letterSpacing: "0.06em", textTransform: "uppercase", width: "fit-content" }}>{e.kind}</span>
                  <span style={{ color: c.dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Compact pages for the rest
function GrPageHeader({ c, kicker, title, action }) {
  return (
    <div style={{ padding: "20px 28px 16px", borderBottom: `1px solid ${c.rule}`, display: "flex", alignItems: "center" }}>
      <div>
        <div style={{ fontFamily: "var(--gr-mono)", fontSize: 10, color: c.dim, letterSpacing: "0.10em", textTransform: "uppercase" }}>{kicker}</div>
        <h1 style={{ margin: "4px 0 0", fontFamily: "var(--gr-sans)", fontSize: 22, fontWeight: 600, color: c.ink, letterSpacing: "-0.02em" }}>{title}</h1>
      </div>
      {action ? <div style={{ marginLeft: "auto" }}>{action}</div> : null}
    </div>
  );
}

function GrCard({ c, children, title, sub }) {
  return (
    <div style={{ background: c.panel, border: `1px solid ${c.rule}`, borderRadius: 8 }}>
      {title ? (
        <div style={{ padding: "14px 18px", borderBottom: `1px solid ${c.ruleSoft}` }}>
          <div style={{ fontFamily: "var(--gr-sans)", fontSize: 14, fontWeight: 600, color: c.ink }}>{title}</div>
          {sub ? <div style={{ fontFamily: "var(--gr-sans)", fontSize: 12, color: c.dim, marginTop: 2 }}>{sub}</div> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function GrPrimaryBtn({ c, children }) {
  return <button style={{ border: `1px solid ${c.accent}`, background: c.accent, color: "white", fontFamily: "var(--gr-sans)", fontSize: 12, fontWeight: 500, padding: "7px 14px", borderRadius: 6, cursor: "pointer" }}>{children}</button>;
}

function GrBrowse({ c }) {
  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <GrPageHeader c={c} kicker="Hybrid search · keyword + vector + graph" title="Browse memories" action={<GrPrimaryBtn c={c}>+ Remember</GrPrimaryBtn>} />
      <div style={{ padding: 20 }}>
        <GrCard c={c}>
          <div style={{ padding: "14px 18px", display: "flex", alignItems: "center", gap: 10, borderBottom: `1px solid ${c.ruleSoft}` }}>
            <span style={{ color: c.faint, fontFamily: "var(--gr-mono)" }}>⌕</span>
            <input defaultValue="sprint plan" style={{ flex: 1, border: "none", outline: "none", background: "transparent", fontFamily: "var(--gr-sans)", fontSize: 14, color: c.ink }} />
            <select defaultValue="phoenix" style={{ border: `1px solid ${c.rule}`, padding: "4px 8px", borderRadius: 6, fontFamily: "var(--gr-mono)", fontSize: 11, background: c.panel, color: c.ink }}>
              <option>phoenix</option><option>atlas</option><option>tenant</option>
            </select>
            <span style={{ fontFamily: "var(--gr-mono)", fontSize: 10, color: c.faint, padding: "2px 6px", border: `1px solid ${c.rule}`, borderRadius: 4 }}>k=10</span>
          </div>
          <div style={{ padding: "10px 18px", fontFamily: "var(--gr-mono)", fontSize: 11, color: c.dim, display: "flex", gap: 14, borderBottom: `1px solid ${c.ruleSoft}` }}>
            <span>{window.NM_DATA.memories.length} hits · 23 ms</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
              <span style={{ color: c.warm }}>● warm 4</span>
              <span style={{ color: c.cold }}>● cold 3</span>
              <span style={{ color: c.graph }}>● graph 0</span>
            </span>
          </div>
          {window.NM_DATA.memories.map((m, i, arr) => (
            <div key={m.id} style={{ padding: "14px 18px", borderBottom: i < arr.length - 1 ? `1px solid ${c.ruleSoft}` : "none", display: "grid", gridTemplateColumns: "auto 1fr 60px 60px 90px", gap: 14, alignItems: "center" }}>
              <span style={{ fontFamily: "var(--gr-mono)", fontSize: 9, color: m.tier === "warm" ? c.warm : c.cold, background: m.tier === "warm" ? c.warmSoft : c.coldSoft, padding: "3px 8px", borderRadius: 99, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", width: "fit-content" }}>{m.tier}</span>
              <div>
                <div style={{ fontFamily: "var(--gr-sans)", fontSize: 13, color: c.ink, lineHeight: 1.5 }}>{m.content}</div>
                <div style={{ fontFamily: "var(--gr-mono)", fontSize: 10, color: c.dim, marginTop: 4 }}>{m.id} · project: {m.project || "—"} · ns: {m.namespace} · {m.age}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontFamily: "var(--gr-sans)", fontSize: 16, color: c.accent, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{m.score.toFixed(2)}</div>
                <div style={{ fontFamily: "var(--gr-mono)", fontSize: 9, color: c.faint }}>score</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontFamily: "var(--gr-sans)", fontSize: 16, color: c.ink, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{m.hits}</div>
                <div style={{ fontFamily: "var(--gr-mono)", fontSize: 9, color: c.faint }}>hits</div>
              </div>
              <div>
                <div style={{ fontFamily: "var(--gr-mono)", fontSize: 9, color: c.faint, marginBottom: 4 }}>decay {(m.decay*100).toFixed(0)}%</div>
                <div style={{ height: 4, background: c.subtle, borderRadius: 2 }}>
                  <div style={{ height: "100%", width: `${m.decay*100}%`, background: m.decay > 0.6 ? c.warm : c.cold, borderRadius: 2 }} />
                </div>
              </div>
            </div>
          ))}
        </GrCard>
      </div>
    </div>
  );
}

function GrToday({ c }) {
  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <GrPageHeader c={c} kicker="Activity · 2026-05-02" title="Today" />
      <div style={{ padding: 20 }}>
        <GrCard c={c}>
          {window.NM_DATA.today.map((e, i, arr) => (
            <div key={i} style={{ padding: "14px 18px", display: "grid", gridTemplateColumns: "auto 100px 1fr", gap: 14, alignItems: "center", borderBottom: i < arr.length - 1 ? `1px solid ${c.ruleSoft}` : "none" }}>
              <div style={{ width: 8, height: 8, borderRadius: 8, background: ({remember:c.graph,search:c.accent,decay:c.warm,share:c.graph,token:c.accent,forget:c.err})[e.kind] || c.faint }} />
              <span style={{ fontFamily: "var(--gr-mono)", fontSize: 11, color: c.dim }}>{e.t}</span>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: "var(--gr-mono)", fontSize: 9, padding: "2px 6px", borderRadius: 4, background: c.subtle, color: c.dim, letterSpacing: "0.06em", textTransform: "uppercase" }}>{e.kind}</span>
                  {e.project ? <span style={{ fontFamily: "var(--gr-mono)", fontSize: 10, color: c.faint }}>{e.project}</span> : null}
                </div>
                <div style={{ fontFamily: "var(--gr-sans)", fontSize: 13, color: c.ink, marginTop: 4 }}>{e.text}</div>
              </div>
            </div>
          ))}
        </GrCard>
      </div>
    </div>
  );
}

function GrProjects({ c }) {
  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <GrPageHeader c={c} kicker="Sub-brains · scoped memory" title="Projects" action={<GrPrimaryBtn c={c}>+ New project</GrPrimaryBtn>} />
      <div style={{ padding: 20, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        {window.NM_DATA.projects.map(p => (
          <div key={p.id} style={{ background: c.panel, border: `1px solid ${c.rule}`, borderRadius: 8, padding: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: c.accentSoft, color: c.accent, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--gr-mono)", fontSize: 16 }}>▢</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: "var(--gr-sans)", fontSize: 15, fontWeight: 600, color: c.ink }}>{p.name}</div>
                <div style={{ fontFamily: "var(--gr-mono)", fontSize: 10, color: c.dim }}>{p.id}</div>
              </div>
              {p.sharedAcrossTenants ? <span style={{ fontFamily: "var(--gr-mono)", fontSize: 9, padding: "2px 6px", borderRadius: 99, background: c.warmSoft, color: c.warm, letterSpacing: "0.06em", textTransform: "uppercase" }}>shared</span> : null}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", marginTop: 16, gap: 8 }}>
              {[["Memories", p.memories.toLocaleString()],["Members", p.members],["Tokens", p.tokens]].map(([l, v]) => (
                <div key={l}>
                  <div style={{ fontFamily: "var(--gr-sans)", fontSize: 18, fontWeight: 600, color: c.ink, fontVariantNumeric: "tabular-nums" }}>{v}</div>
                  <div style={{ fontFamily: "var(--gr-mono)", fontSize: 9, color: c.faint, letterSpacing: "0.06em", textTransform: "uppercase" }}>{l}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: "var(--gr-mono)", fontSize: 11, color: c.dim, paddingTop: 12, borderTop: `1px solid ${c.ruleSoft}` }}>
              <span>{p.role} · {p.lastActivity}</span>
              <span style={{ color: c.accent, cursor: "pointer" }}>open →</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function GrTokens({ c }) {
  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <GrPageHeader c={c} kicker="Per-device · plaintext shown once" title="API tokens" action={<GrPrimaryBtn c={c}>+ Mint token</GrPrimaryBtn>} />
      <div style={{ padding: 20, display: "grid", gridTemplateColumns: "1fr 320px", gap: 12 }}>
        <GrCard c={c} title="Tokens" sub={`${window.NM_DATA.tokens.length} active`}>
          <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1.2fr 1fr 1fr 0.8fr 60px", padding: "8px 18px", background: c.subtle, fontFamily: "var(--gr-mono)", fontSize: 10, color: c.dim, letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: `1px solid ${c.ruleSoft}` }}>
            <span>Label</span><span>Scope</span><span>Hash</span><span>Last used</span><span>24 h</span><span></span>
          </div>
          {window.NM_DATA.tokens.map((t, i, arr) => (
            <div key={t.id} style={{ display: "grid", gridTemplateColumns: "1.4fr 1.2fr 1fr 1fr 0.8fr 60px", padding: "12px 18px", borderBottom: i < arr.length - 1 ? `1px solid ${c.ruleSoft}` : "none", alignItems: "center", fontFamily: "var(--gr-sans)", fontSize: 12, color: c.ink }}>
              <span style={{ fontWeight: 500 }}>{t.label}</span>
              <span><span style={{ fontFamily: "var(--gr-mono)", fontSize: 10, padding: "2px 8px", borderRadius: 99, background: t.scope.startsWith("project") ? c.warmSoft : c.accentSoft, color: t.scope.startsWith("project") ? c.warm : c.accent }}>{t.scope}</span></span>
              <span style={{ fontFamily: "var(--gr-mono)", fontSize: 11, color: c.faint }}>{t.hash}</span>
              <span style={{ fontFamily: "var(--gr-mono)", fontSize: 11, color: c.dim }}>{t.lastUsed}</span>
              <span style={{ fontFamily: "var(--gr-mono)", fontSize: 11, color: c.dim, fontVariantNumeric: "tabular-nums" }}>{t.uses_24h.toLocaleString()}</span>
              <span style={{ textAlign: "right", fontFamily: "var(--gr-sans)", fontSize: 11, color: c.err, cursor: "pointer" }}>revoke</span>
            </div>
          ))}
        </GrCard>
        <GrCard c={c} title="Usage · 24 h">
          <div style={{ padding: 18 }}>
            {window.NM_DATA.tokens.map(t => {
              const max = Math.max(...window.NM_DATA.tokens.map(x => x.uses_24h));
              const w = max ? (t.uses_24h / max) * 100 : 0;
              return (
                <div key={t.id} style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--gr-sans)", fontSize: 11, color: c.ink, marginBottom: 4 }}>
                    <span>{t.label}</span>
                    <span style={{ color: c.dim, fontFamily: "var(--gr-mono)", fontVariantNumeric: "tabular-nums" }}>{t.uses_24h.toLocaleString()}</span>
                  </div>
                  <div style={{ height: 4, background: c.subtle, borderRadius: 2 }}>
                    <div style={{ height: "100%", width: `${w}%`, background: t.scope.startsWith("project") ? c.warm : c.accent, borderRadius: 2 }} />
                  </div>
                </div>
              );
            })}
          </div>
        </GrCard>
      </div>
    </div>
  );
}

function GrHealth({ c }) {
  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <GrPageHeader c={c} kicker="Dependency snapshot · polled 5 s" title="Health" />
      <div style={{ padding: 20, display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
        {window.NM_DATA.health.map((h, i) => {
          const ok = h.status === "ok";
          const trend = window.NM_DATA.history.slice(-30).map(d => d.q + (i % 2 ? 0.5 : 0));
          return (
            <div key={h.name} style={{ background: c.panel, border: `1px solid ${c.rule}`, borderRadius: 8, padding: 18, display: "grid", gridTemplateColumns: "1fr auto auto", gap: 14, alignItems: "center" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 8, background: ok ? c.graph : c.warn, boxShadow: `0 0 0 3px ${ok ? c.graphSoft : c.warmSoft}` }} />
                  <h3 style={{ margin: 0, fontFamily: "var(--gr-sans)", fontSize: 15, fontWeight: 600, color: c.ink }}>{h.name}</h3>
                  <span style={{ fontFamily: "var(--gr-mono)", fontSize: 10, color: c.dim }}>{h.role}</span>
                </div>
                <div style={{ fontFamily: "var(--gr-mono)", fontSize: 11, color: c.dim, marginTop: 6 }}>{h.host} · v{h.version}</div>
              </div>
              <GrSpark c={c} data={trend} color={ok ? c.graph : c.warn} w={80} h={28} />
              <div style={{ textAlign: "right" }}>
                <div style={{ fontFamily: "var(--gr-sans)", fontSize: 18, fontWeight: 600, color: ok ? c.graph : c.warn, fontVariantNumeric: "tabular-nums" }}>{h.latency_ms}<span style={{ fontFamily: "var(--gr-mono)", fontSize: 11, color: c.dim, fontWeight: 400, marginLeft: 2 }}>ms</span></div>
                <div style={{ fontFamily: "var(--gr-mono)", fontSize: 9, padding: "2px 6px", borderRadius: 99, background: ok ? c.graphSoft : c.warmSoft, color: ok ? c.graph : c.warn, letterSpacing: "0.06em", textTransform: "uppercase", marginTop: 4, display: "inline-block" }}>{h.status}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GrTenants({ c }) {
  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <GrPageHeader c={c} kicker={`${window.NM_DATA.tenants.length} active · enforced server-side`} title="Tenants" action={<GrPrimaryBtn c={c}>+ Create tenant</GrPrimaryBtn>} />
      <div style={{ padding: 20 }}>
        <GrCard c={c}>
          <div style={{ display: "grid", gridTemplateColumns: "1.6fr 0.8fr 0.8fr 1fr 1fr 80px", padding: "8px 18px", background: c.subtle, fontFamily: "var(--gr-mono)", fontSize: 10, color: c.dim, letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: `1px solid ${c.ruleSoft}` }}>
            <span>Tenant</span><span>Users</span><span>Tokens</span><span>Memories</span><span>Created</span><span></span>
          </div>
          {window.NM_DATA.tenants.map((t, i, arr) => (
            <div key={t.id} style={{ display: "grid", gridTemplateColumns: "1.6fr 0.8fr 0.8fr 1fr 1fr 80px", padding: "14px 18px", borderBottom: i < arr.length - 1 ? `1px solid ${c.ruleSoft}` : "none", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 30, height: 30, borderRadius: 8, background: c.accentSoft, color: c.accent, fontFamily: "var(--gr-sans)", fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>{t.name[0]}</div>
                <div>
                  <div style={{ fontFamily: "var(--gr-sans)", fontSize: 13, color: c.ink, fontWeight: 500 }}>{t.name}</div>
                  <div style={{ fontFamily: "var(--gr-mono)", fontSize: 10, color: c.dim }}>{t.id}</div>
                </div>
              </div>
              <span style={{ fontFamily: "var(--gr-sans)", fontSize: 13, color: c.ink, fontVariantNumeric: "tabular-nums" }}>{t.users}</span>
              <span style={{ fontFamily: "var(--gr-sans)", fontSize: 13, color: c.ink, fontVariantNumeric: "tabular-nums" }}>{t.tokens}</span>
              <span style={{ fontFamily: "var(--gr-sans)", fontSize: 13, color: c.ink, fontVariantNumeric: "tabular-nums" }}>{t.memories.toLocaleString()}</span>
              <span style={{ fontFamily: "var(--gr-mono)", fontSize: 11, color: c.dim }}>{t.created}</span>
              <span style={{ textAlign: "right", fontFamily: "var(--gr-sans)", fontSize: 11, color: c.err, cursor: "pointer" }}>purge</span>
            </div>
          ))}
        </GrCard>
      </div>
    </div>
  );
}

function GrUsers({ c }) {
  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <GrPageHeader c={c} kicker="Dashboard auth · username + password" title="Users" action={<GrPrimaryBtn c={c}>+ Create user</GrPrimaryBtn>} />
      <div style={{ padding: 20 }}>
        <GrCard c={c}>
          <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr 1fr 100px", padding: "8px 18px", background: c.subtle, fontFamily: "var(--gr-mono)", fontSize: 10, color: c.dim, letterSpacing: "0.06em", textTransform: "uppercase", borderBottom: `1px solid ${c.ruleSoft}` }}>
            <span>User</span><span>Role</span><span>Tenant</span><span>Last seen</span><span></span>
          </div>
          {window.NM_DATA.users.map((u, i, arr) => (
            <div key={u.id} style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 1fr 1fr 100px", padding: "12px 18px", borderBottom: i < arr.length - 1 ? `1px solid ${c.ruleSoft}` : "none", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 30, height: 30, borderRadius: 30, background: c.subtle, color: c.dim, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--gr-sans)", fontSize: 12, fontWeight: 600 }}>{u.username[0].toUpperCase()}</div>
                <span style={{ fontFamily: "var(--gr-sans)", fontSize: 13, color: c.ink, fontWeight: 500 }}>{u.username}</span>
              </div>
              <span><span style={{ fontFamily: "var(--gr-mono)", fontSize: 10, padding: "2px 8px", borderRadius: 99, background: u.role === "admin" ? c.accentSoft : c.subtle, color: u.role === "admin" ? c.accent : c.dim, letterSpacing: "0.06em", textTransform: "uppercase" }}>{u.role}</span></span>
              <span style={{ fontFamily: "var(--gr-mono)", fontSize: 11, color: c.dim }}>{u.tenantId || "—"}</span>
              <span style={{ fontFamily: "var(--gr-mono)", fontSize: 11, color: c.faint }}>{u.lastSeen}</span>
              <div style={{ textAlign: "right", fontFamily: "var(--gr-sans)", fontSize: 11 }}>
                <span style={{ color: c.dim, marginRight: 12, cursor: "pointer" }}>edit</span>
                <span style={{ color: c.err, cursor: "pointer" }}>delete</span>
              </div>
            </div>
          ))}
        </GrCard>
      </div>
    </div>
  );
}

function GrGraph({ c }) {
  const g = window.NM_DATA.graph;
  const [seed, setSeed] = React.useState("m_8a3f");
  const W = 800, H = 460;
  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <GrPageHeader c={c} kicker={`Neighbours · seed ${seed}`} title="Memory graph" action={<span style={{ fontFamily: "var(--gr-mono)", fontSize: 10, padding: "4px 10px", borderRadius: 99, background: c.warmSoft, color: c.warm }}>● falkor degraded · 412 ms p95</span>} />
      <div style={{ padding: 20, display: "grid", gridTemplateColumns: "1fr 280px", gap: 12 }}>
        <GrCard c={c}>
          <div style={{ position: "relative" }}>
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
              <defs>
                <radialGradient id="gr-nodeglow" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor={c.accent} stopOpacity="0.3" />
                  <stop offset="100%" stopColor={c.accent} stopOpacity="0" />
                </radialGradient>
              </defs>
              {g.edges.map(([a, b, w], i) => {
                const A = g.nodes.find(n => n.id === a);
                const B = g.nodes.find(n => n.id === b);
                return <line key={i} x1={A.x*W} y1={A.y*H} x2={B.x*W} y2={B.y*H} stroke={c.dim} strokeWidth={w*1.6} strokeOpacity="0.4" />;
              })}
              {g.nodes.map(n => {
                const r = 8 + n.hits * 0.45;
                const isSeed = n.id === seed;
                const color = n.tier === "warm" ? c.warm : c.cold;
                return (
                  <g key={n.id} style={{ cursor: "pointer" }} onClick={() => setSeed(n.id)}>
                    {isSeed ? <circle cx={n.x*W} cy={n.y*H} r={r * 3.5} fill="url(#gr-nodeglow)" /> : null}
                    <circle cx={n.x*W} cy={n.y*H} r={r} fill={color} stroke={c.panel} strokeWidth="3" />
                    <text x={n.x*W} y={n.y*H + r + 16} textAnchor="middle" fontSize="11" fontFamily="var(--gr-sans)" fontWeight="500" fill={c.ink}>{n.label}</text>
                    <text x={n.x*W} y={n.y*H + r + 28} textAnchor="middle" fontSize="9" fontFamily="var(--gr-mono)" fill={c.faint}>{n.id}</text>
                  </g>
                );
              })}
            </svg>
          </div>
        </GrCard>
        <GrCard c={c} title="Inspector">
          <div style={{ padding: 18 }}>
            {(() => {
              const n = g.nodes.find(x => x.id === seed);
              const edges = g.edges.filter(([a,b]) => a===seed||b===seed);
              return (
                <>
                  <div style={{ fontFamily: "var(--gr-sans)", fontSize: 16, color: c.ink, fontWeight: 600 }}>{n.label}</div>
                  <div style={{ fontFamily: "var(--gr-mono)", fontSize: 11, color: c.dim, marginTop: 2 }}>{n.id}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 16 }}>
                    <div><div style={{ fontFamily: "var(--gr-sans)", fontSize: 18, fontWeight: 600, color: c.ink }}>{n.hits}</div><div style={{ fontFamily: "var(--gr-mono)", fontSize: 9, color: c.faint, textTransform: "uppercase" }}>Hits</div></div>
                    <div><div style={{ fontFamily: "var(--gr-sans)", fontSize: 18, fontWeight: 600, color: c.ink }}>{edges.length}</div><div style={{ fontFamily: "var(--gr-mono)", fontSize: 9, color: c.faint, textTransform: "uppercase" }}>Edges</div></div>
                  </div>
                  <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${c.ruleSoft}`, fontFamily: "var(--gr-mono)", fontSize: 11, color: c.dim }}>
                    Tier: <span style={{ color: n.tier === "warm" ? c.warm : c.cold }}>{n.tier}</span><br/>
                    Click any node to recenter the subgraph.
                  </div>
                </>
              );
            })()}
          </div>
        </GrCard>
      </div>
    </div>
  );
}

function GrApp({ dark = false, role = "user", initial = "metrics" }) {
  const c = grTokens(dark);
  const [active, setActive] = React.useState(initial);
  const user = role === "admin" ? window.NM_DATA.admin : window.NM_DATA.user;
  const Page = ({ metrics: GrMetrics, browse: GrBrowse, today: GrToday, projects: GrProjects, tokens: GrTokens, health: GrHealth, tenants: GrTenants, users: GrUsers, graph: GrGraph })[active] || GrMetrics;
  return (
    <div style={{
      width: "100%", height: "100%", background: c.bg, color: c.ink, display: "flex",
      "--gr-sans": "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
      "--gr-mono": "'JetBrains Mono', ui-monospace, Menlo, monospace",
      fontFamily: "var(--gr-sans)",
    }}>
      <GrSidebar c={c} active={active} onChange={setActive} user={user} />
      <Page c={c} user={user} />
    </div>
  );
}

function GrSignIn({ dark = false }) {
  const c = grTokens(dark);
  return (
    <div style={{ width: "100%", height: "100%", background: c.bg, display: "flex", alignItems: "center", justifyContent: "center", "--gr-sans": "'Inter', sans-serif", "--gr-mono": "'JetBrains Mono', monospace", fontFamily: "var(--gr-sans)" }}>
      <div style={{ width: 380, background: c.panel, border: `1px solid ${c.rule}`, borderRadius: 12, padding: 32, boxShadow: dark ? "0 20px 60px rgba(0,0,0,0.4)" : "0 12px 40px rgba(0,0,0,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: c.accent, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 6 L12 12 M20 6 L12 12 M4 18 L12 12 M20 18 L12 12" stroke="white" strokeWidth="1.4"/><circle cx="12" cy="12" r="2.6" fill="white"/></svg>
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: c.ink }}>NovaMem</div>
            <div style={{ fontFamily: "var(--gr-mono)", fontSize: 10, color: c.dim }}>v0.4.2</div>
          </div>
        </div>
        <h2 style={{ margin: "0 0 6px", fontSize: 20, fontWeight: 600, color: c.ink, letterSpacing: "-0.015em" }}>Sign in to your console</h2>
        <p style={{ margin: 0, fontSize: 13, color: c.dim }}>Use your dashboard username — not a bearer token.</p>

        <div style={{ marginTop: 22 }}>
          <label style={{ fontSize: 12, fontWeight: 500, color: c.ink }}>Username</label>
          <input defaultValue="akiyo" style={{ width: "100%", marginTop: 6, padding: "10px 12px", border: `1px solid ${c.rule}`, borderRadius: 8, background: c.bg, color: c.ink, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
        </div>
        <div style={{ marginTop: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 500, color: c.ink }}>Password</label>
          <input type="password" defaultValue="••••••••••" style={{ width: "100%", marginTop: 6, padding: "10px 12px", border: `1px solid ${c.rule}`, borderRadius: 8, background: c.bg, color: c.ink, fontSize: 14, outline: "none", boxSizing: "border-box" }} />
        </div>
        <button style={{ marginTop: 22, width: "100%", padding: "11px", border: `1px solid ${c.accent}`, background: c.accent, color: "white", fontSize: 13, fontWeight: 600, borderRadius: 8, cursor: "pointer" }}>Continue</button>
        <div style={{ marginTop: 18, fontFamily: "var(--gr-mono)", fontSize: 10, color: c.faint, lineHeight: 1.6, textAlign: "center" }}>
          Session expires in 24h · stored in sessionStorage
        </div>
      </div>
    </div>
  );
}

function GrOnboarding({ dark = false }) {
  const c = grTokens(dark);
  const steps = [
    { n: 1, label: "Bootstrap admin", done: true, hint: "Seeded from env" },
    { n: 2, label: "Tenant created", done: true, hint: "acme · 1 user" },
    { n: 3, label: "Mint your first token", done: false, active: true, hint: "scope it to a project, or tenant-wide" },
    { n: 4, label: "Connect your agent", done: false, hint: "MCP stdio · SSE · raw HTTP" },
    { n: 5, label: "Remember something", done: false, hint: "Watch it land in Browse" },
  ];
  return (
    <div style={{ width: "100%", height: "100%", background: c.bg, color: c.ink, padding: 32, "--gr-sans": "'Inter', sans-serif", "--gr-mono": "'JetBrains Mono', monospace", fontFamily: "var(--gr-sans)", overflow: "auto" }}>
      <div style={{ maxWidth: 880, margin: "0 auto" }}>
        <div style={{ display: "inline-block", padding: "4px 10px", background: c.accentSoft, color: c.accent, borderRadius: 99, fontFamily: "var(--gr-mono)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" }}>Welcome</div>
        <h1 style={{ margin: "12px 0 8px", fontSize: 36, fontWeight: 600, color: c.ink, letterSpacing: "-0.025em" }}>Let's give your agent memory</h1>
        <div style={{ fontSize: 15, color: c.dim }}>5 steps · 2 already done</div>

        <div style={{ marginTop: 28, background: c.panel, border: `1px solid ${c.rule}`, borderRadius: 12, overflow: "hidden" }}>
          {steps.map((s, i, arr) => (
            <div key={s.n} style={{
              display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 14, padding: "20px 22px",
              alignItems: "center", borderBottom: i < arr.length - 1 ? `1px solid ${c.ruleSoft}` : "none",
              background: s.active ? c.accentSoft : "transparent",
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: 36, flex: "0 0 36px",
                background: s.done ? c.accent : (s.active ? c.panel : "transparent"),
                border: s.done ? "none" : `2px solid ${s.active ? c.accent : c.rule}`,
                color: s.done ? "white" : (s.active ? c.accent : c.faint),
                display: "flex", alignItems: "center", justifyContent: "center",
                fontFamily: "var(--gr-sans)", fontSize: 14, fontWeight: 600,
              }}>{s.done ? "✓" : s.n}</div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: c.ink }}>{s.label}</div>
                <div style={{ fontSize: 12, color: c.dim, marginTop: 2 }}>{s.hint}</div>
              </div>
              {s.active ? <button style={{ border: `1px solid ${c.accent}`, background: c.accent, color: "white", fontSize: 12, fontWeight: 500, padding: "7px 14px", borderRadius: 6, cursor: "pointer" }}>Continue →</button> : (s.done ? null : <span style={{ fontFamily: "var(--gr-mono)", fontSize: 11, color: c.faint }}>queued</span>)}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 24, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {[
            ["Warm tier", "postgres FTS · keyword search", c.warm],
            ["Cold tier", "qdrant · vector cosine", c.cold],
            ["Graph", "falkor · neighbours", c.graph],
          ].map(([t, d, color]) => (
            <div key={t} style={{ background: c.panel, border: `1px solid ${c.rule}`, borderRadius: 8, padding: 16 }}>
              <div style={{ width: 8, height: 8, borderRadius: 8, background: color }} />
              <div style={{ fontSize: 14, fontWeight: 600, color: c.ink, marginTop: 10 }}>{t}</div>
              <div style={{ fontFamily: "var(--gr-mono)", fontSize: 11, color: c.dim, marginTop: 4 }}>{d}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

window.Grid = { GrApp, GrSignIn, GrOnboarding, grTokens };
