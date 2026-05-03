/**
 * Lightweight in-memory fakes for the engine's three stores + embedder.
 * Keeps tests fast and deterministic without docker / postgres / qdrant.
 */

import { createHash } from "node:crypto";

import type { ColdStore } from "./cold-store.js";
import type { GraphStore } from "./graph-store.js";
import type { Embedder } from "./embeddings.js";
import type { WarmStore } from "./warm-store/index.js";
import { ulid } from "ulid";

export interface FakeWarmRow {
  id: string;
  tenantId: string;
  projectId: string | null;
  content: string;
  namespace: string;
  source: string;
  agentName: string | null;
  metadata: Record<string, unknown>;
  cold: boolean;
  createdAt: Date;
  hits: number;
  lastAccessed: Date;
}

export class FakeWarmStore {
  rows = new Map<string, FakeWarmRow>();
  relations: Array<{ tenantId: string; projectId: string | null; fromId: string; toId: string; relation: string; strength: number }> = [];
  tenants = new Map<string, { id: string; name: string }>([["public", { id: "public", name: "public" }]]);
  tokens = new Map<string, { tenantId: string; label: string | null; createdByUserId: string | null; projectId: string | null; revoked: boolean }>();
  users = new Map<string, { id: string; username: string; passwordHash: string; role: string; tenantId: string | null; createdAt: Date; lastLoginAt: Date | null }>();
  sessions = new Map<string, { userId: string; expiresAt: Date }>();
  projects = new Map<string, { id: string; name: string; ownerUserId: string; ownerTenantId: string; createdAt: Date }>();
  projectMembers = new Map<string, Map<string, { role: string; joinedAt: Date }>>();
  decayRunsInserted = 0;
  decayRunsUpdated = 0;
  coldOrphans = new Map<
    string,
    { id: string; tenantId: string; namespace: string; attempts: number; lastError: string; lastAttemptAt: Date | null }
  >();
  pool = {
    /** Fake the pool query surface used by engine.recent + engine.forget +
     *  engine.decay. Only the queries the engine actually issues are wired —
     *  anything else throws so tests fail loudly on unexpected SQL. */
    query: async (sql: string, params: unknown[] = []): Promise<{ rows: any[] }> => {
      // recent()
      if (sql.includes("FROM memory_entries") && sql.includes("namespace = $1")) {
        // Engine SQL: params[0] = namespace, params[1] = k, params[2] = tenantId or projectId,
        // optional params[3] = since.
        const namespace = String(params[0]);
        const k = Number(params[1]);
        const projectScoped = sql.includes("project_id = $");
        const tenantScoped = sql.includes("tenant_id = $");
        const tenantId = tenantScoped ? String(params[2]) : null;
        const projectId = projectScoped ? String(params[2]) : null;
        const since = sql.includes("created_at >= $") ? new Date(String(params[3])) : null;
        const filtered = [...this.rows.values()]
          .filter((r) => r.namespace === namespace)
          .filter((r) => {
            if (projectScoped) return r.projectId === projectId;
            return r.projectId === null && r.tenantId === tenantId;
          })
          .filter((r) => !since || r.createdAt >= since)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, k)
          .map((r) => ({
            id: r.id,
            content: r.content,
            namespace: r.namespace,
            project_id: r.projectId,
            source: r.source,
            metadata: r.metadata,
            cold: r.cold,
            created_at: r.createdAt,
          }));
        return { rows: filtered };
      }
      // decay run start
      if (sql.startsWith("INSERT INTO decay_runs")) {
        this.decayRunsInserted++;
        return { rows: [{ id: this.decayRunsInserted }] };
      }
      // decay run finish
      if (sql.startsWith("UPDATE decay_runs")) {
        this.decayRunsUpdated++;
        return { rows: [] };
      }
      // P0-6 bulk decay SQL: `WITH candidates AS (...) UPDATE memory_entries
      // SET cold = true ...`. Replicate the demote condition in JS.
      if (sql.includes("WITH candidates AS") && sql.includes("UPDATE memory_entries")) {
        const baseDays = Number(params[0]);
        const now = Date.now();
        const rows: Array<{ id: string }> = [];
        for (const r of this.rows.values()) {
          if (r.cold) continue;
          const idleDays = (now - r.lastAccessed.getTime()) / (1000 * 60 * 60 * 24);
          // lifespan = baseDays * log2(hits + 1); demote when idle > lifespan.
          const lifespan = baseDays * Math.log2(Math.max(r.hits, 0) + 1);
          if (idleDays > lifespan) {
            r.cold = true;
            rows.push({ id: r.id });
          }
        }
        // pg returns rowCount in addition to rows; the engine reads rowCount.
        return { rows, rowCount: rows.length } as { rows: { id: string }[]; rowCount: number };
      }
      // forget()
      // The engine's forget builds the scope clause as either
      // `project_id = $2` or `tenant_id = $2` depending on whether the
      // entry is project-scoped. Inspect the SQL to know which.
      if (sql.startsWith("DELETE FROM memory_fts")) return { rows: [] };
      if (sql.startsWith("DELETE FROM memory_access")) return { rows: [] };
      if (sql.startsWith("DELETE FROM memory_relations")) {
        const id = String(params[0]);
        const scope = String(params[1]);
        const isProject = sql.includes("project_id = $");
        this.relations = this.relations.filter((r) => {
          const isMatch = r.fromId === id || r.toId === id;
          if (!isMatch) return true;
          return isProject ? r.projectId !== scope : r.tenantId !== scope;
        });
        return { rows: [] };
      }
      if (sql.startsWith("DELETE FROM memory_entries")) {
        const id = String(params[0]);
        const scope = String(params[1]);
        const isProject = sql.includes("project_id = $");
        const r = this.rows.get(id);
        if (r) {
          if (isProject ? r.projectId === scope : r.tenantId === scope) {
            this.rows.delete(id);
          }
        }
        return { rows: [] };
      }
      // addRelation()
      if (sql.startsWith("INSERT INTO memory_relations")) {
        const [tenantId, projectId, fromId, toId, relation, strength] = params as [
          string,
          string | null,
          string,
          string,
          string,
          number,
        ];
        const i = this.relations.findIndex(
          (r) => r.fromId === fromId && r.toId === toId && r.relation === relation,
        );
        if (i >= 0) {
          this.relations[i]!.strength = strength;
          this.relations[i]!.tenantId = tenantId;
          this.relations[i]!.projectId = projectId;
        } else {
          this.relations.push({ tenantId, projectId, fromId, toId, relation, strength });
        }
        return { rows: [] };
      }
      // cold_orphans: insert / update / select / delete + count
      if (sql.includes("INSERT INTO cold_orphans")) {
        const id = String(params[0]);
        const tenantId = String(params[1]);
        const namespace = String(params[2]);
        // params[3] is project_id (nullable), params[4] is lastError
        const lastError = String(params[4] ?? "");
        const cur = this.coldOrphans.get(id);
        if (cur) {
          cur.attempts += 1;
          cur.lastError = lastError;
          cur.lastAttemptAt = new Date();
        } else {
          this.coldOrphans.set(id, {
            id,
            tenantId,
            namespace,
            attempts: 1,
            lastError,
            lastAttemptAt: new Date(),
          });
        }
        return { rows: [] };
      }
      if (sql.startsWith("SELECT id, tenant_id, namespace, project_id, attempts FROM cold_orphans")) {
        const maxAttempts = Number(params[0]);
        const limit = Number(params[1]);
        return {
          rows: [...this.coldOrphans.values()]
            .filter((o) => o.attempts < maxAttempts)
            .sort((a, b) => (a.lastAttemptAt?.getTime() ?? 0) - (b.lastAttemptAt?.getTime() ?? 0))
            .slice(0, limit)
            .map((o) => ({
              id: o.id,
              tenant_id: o.tenantId,
              namespace: o.namespace,
              project_id: null,
              attempts: o.attempts,
            })),
        };
      }
      if (sql.startsWith("UPDATE cold_orphans")) {
        const o = this.coldOrphans.get(String(params[2]));
        if (o) {
          o.attempts = Number(params[0]);
          o.lastError = String(params[1] ?? "");
          o.lastAttemptAt = new Date();
        }
        return { rows: [] };
      }
      if (sql.startsWith("DELETE FROM cold_orphans")) {
        this.coldOrphans.delete(String(params[0]));
        return { rows: [] };
      }
      if (sql.includes("FILTER (WHERE attempts <") && sql.includes("cold_orphans")) {
        const maxAttempts = Number(params[0]);
        const all = [...this.coldOrphans.values()];
        const pending = all.filter((o) => o.attempts < maxAttempts).length;
        return { rows: [{ pending: String(pending), total: String(all.length) }] };
      }
      // getColdEntryStats
      if (sql.includes("FROM memory_access") && sql.includes("WHERE a.entry_id = $1")) {
        const id = String(params[0]);
        const r = this.rows.get(id);
        if (!r) return { rows: [] };
        const idleDays = (Date.now() - r.lastAccessed.getTime()) / (1000 * 60 * 60 * 24);
        return { rows: [{ hits: r.hits, idle_days: String(idleDays) }] };
      }
      throw new Error(`fake pool: unhandled SQL — ${sql.slice(0, 60)}`);
    },
  };

  async ping(): Promise<boolean> { return true; }
  async close(): Promise<void> { /* no-op */ }

  async insertEntry(args: {
    tenantId: string;
    projectId?: string | null;
    content: string;
    namespace: string;
    source: string;
    agentName?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const id = ulid();
    this.rows.set(id, {
      id,
      tenantId: args.tenantId,
      projectId: args.projectId ?? null,
      content: args.content,
      namespace: args.namespace,
      source: args.source,
      agentName: args.agentName ?? null,
      metadata: args.metadata ?? {},
      cold: false,
      createdAt: new Date(),
      hits: 0,
      lastAccessed: new Date(),
    });
    return id;
  }

  async ftsSearch(args: {
    tenantId: string;
    projectId?: string | null;
    query: string;
    namespace: string;
    k: number;
    agentName?: string | null;
  }): Promise<Array<{ id: string; score: number }>> {
    const q = args.query.toLowerCase();
    const projectId = args.projectId ?? null;
    const matches = [...this.rows.values()]
      .filter((r) => r.tenantId === args.tenantId && r.namespace === args.namespace)
      .filter((r) => r.projectId === projectId)
      .filter((r) => {
        if (args.agentName === undefined) return true;
        return args.agentName === null ? r.agentName === null : r.agentName === args.agentName;
      })
      .map((r) => {
        const tokens = q.split(/\s+/).filter(Boolean);
        const hits = tokens.filter((t) => r.content.toLowerCase().includes(t)).length;
        return hits > 0 ? { id: r.id, score: hits / Math.max(tokens.length, 1) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b!.score - a!.score)
      .slice(0, args.k)
      .map((m) => m!);
    return matches;
  }

  async getEntry(tenantId: string, id: string, opts: { projectId?: string | null } = {}) {
    const r = this.rows.get(id);
    if (!r) return undefined;
    if (typeof opts.projectId === "string") {
      // Project IS the isolation unit when set (cross-tenant members allowed).
      if (r.projectId !== opts.projectId) return undefined;
    } else {
      // Tenant-wide queries: project must be null AND tenant must match.
      if (r.projectId !== null) return undefined;
      if (r.tenantId !== tenantId) return undefined;
    }
    return {
      id: r.id,
      tenantId: r.tenantId,
      projectId: r.projectId,
      content: r.content,
      namespace: r.namespace,
      source: r.source,
      agentName: r.agentName,
      metadata: r.metadata,
      cold: r.cold,
      createdAt: r.createdAt,
      updatedAt: r.createdAt,
    };
  }

  async bumpHits(id: string): Promise<void> {
    const r = this.rows.get(id);
    if (r) {
      r.hits += 1;
      r.lastAccessed = new Date();
    }
  }

  async bumpHitsMany(ids: string[]): Promise<void> {
    for (const id of ids) await this.bumpHits(id);
  }

  async getEntries(tenantId: string, ids: string[], opts: { projectId?: string | null } = {}) {
    return Promise.all(ids.map((id) => this.getEntry(tenantId, id, opts)));
  }

  async listColdCandidates(_effectiveDays: number, _limit = 1000) {
    const now = Date.now();
    return {
      rows: [...this.rows.values()]
        .filter((r) => !r.cold)
        .map((r) => ({
          id: r.id,
          tenant_id: r.tenantId,
          namespace: r.namespace,
          hits: r.hits,
          idle_days: (now - r.lastAccessed.getTime()) / (1000 * 60 * 60 * 24),
        })),
    };
  }

  async markCold(id: string, cold: boolean): Promise<void> {
    const r = this.rows.get(id);
    if (r) r.cold = cold;
  }

  async addRelation(
    tenantId: string,
    fromId: string,
    toId: string,
    relation: string,
    strength: number,
    projectId?: string | null,
  ): Promise<void> {
    const i = this.relations.findIndex(
      (r) => r.fromId === fromId && r.toId === toId && r.relation === relation,
    );
    if (i >= 0) {
      this.relations[i]!.strength = strength;
      this.relations[i]!.tenantId = tenantId;
      this.relations[i]!.projectId = projectId ?? null;
    } else {
      this.relations.push({ tenantId, projectId: projectId ?? null, fromId, toId, relation, strength });
    }
  }

  async getColdEntryStats(id: string): Promise<{ hits: number; idleDays: number } | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    return {
      hits: r.hits,
      idleDays: (Date.now() - r.lastAccessed.getTime()) / (1000 * 60 * 60 * 24),
    };
  }

  async stats(tenantId: string) {
    const rows: Array<{ namespace: string; cold: boolean; count: string }> = [];
    const groups = new Map<string, number>();
    for (const r of this.rows.values()) {
      if (r.tenantId !== tenantId) continue;
      const key = `${r.namespace}::${r.cold}`;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }
    for (const [key, count] of groups) {
      const [namespace, coldStr] = key.split("::");
      rows.push({ namespace: namespace!, cold: coldStr === "true", count: String(count) });
    }
    return { rows, lastDecayAt: null };
  }

  // ─── Tenant ops (used by HTTP auth hook + admin routes) ───────────────
  async createTenant(id: string, name: string) {
    if (!this.tenants.has(id)) this.tenants.set(id, { id, name });
    return this.tenants.get(id)!;
  }

  async listTenants() {
    return [...this.tenants.values()].map((t) => ({ ...t, createdAt: new Date() }));
  }

  async createTenantToken(
    tenantId: string,
    label?: string,
    createdByUserId?: string | null,
    projectId?: string | null,
  ) {
    if (!this.tenants.has(tenantId)) return null;
    const token = "nm_test_" + Math.random().toString(36).slice(2, 18);
    this.tokens.set(token, {
      tenantId,
      label: label ?? null,
      createdByUserId: createdByUserId ?? null,
      projectId: projectId ?? null,
      revoked: false,
    });
    return { token, tenantId, projectId: projectId ?? null, createdAt: new Date() };
  }

  async resolveTenantToken(plaintext: string) {
    const t = this.tokens.get(plaintext);
    if (!t || t.revoked) return null;
    return {
      tenantId: t.tenantId,
      projectId: t.projectId,
      tokenHash: this.fakeHash(plaintext),
      label: t.label,
    };
  }

  async listTokensCreatedByUser(userId: string) {
    const out: Array<{ tokenHash: string; label: string | null; tenantId: string }> = [];
    for (const [plain, v] of this.tokens.entries()) {
      if (v.createdByUserId === userId && !v.revoked) {
        out.push({ tokenHash: this.fakeHash(plain), label: v.label, tenantId: v.tenantId });
      }
    }
    return out;
  }

  async revokeTenantToken(plaintext: string): Promise<boolean> {
    const t = this.tokens.get(plaintext);
    if (!t || t.revoked) return false;
    t.revoked = true;
    return true;
  }

  /** Match the real warm-store: sha256 hex. The route-level validation
   *  regex `^[a-f0-9]{64}$` then accepts our fake hashes too. */
  private fakeHash(plaintext: string): string {
    return createHash("sha256").update(plaintext).digest("hex");
  }

  async revokeTenantTokenByHash(tenantId: string, tokenHash: string): Promise<boolean> {
    for (const [plain, v] of this.tokens.entries()) {
      if (v.tenantId === tenantId && this.fakeHash(plain) === tokenHash && !v.revoked) {
        v.revoked = true;
        return true;
      }
    }
    return false;
  }

  async rotateTenantToken(plaintext: string) {
    const t = this.tokens.get(plaintext);
    if (!t || t.revoked) return null;
    t.revoked = true;
    const newToken = "nm_test_" + Math.random().toString(36).slice(2, 18);
    this.tokens.set(newToken, { tenantId: t.tenantId, label: "rotated", revoked: false });
    return { token: newToken, tenantId: t.tenantId, createdAt: new Date() };
  }

  async deleteTenant(id: string) {
    if (id === "public") return { deleted: false, entriesRemoved: 0 };
    if (!this.tenants.has(id)) return { deleted: false, entriesRemoved: 0 };
    let entriesRemoved = 0;
    for (const [rid, r] of [...this.rows.entries()]) {
      if (r.tenantId === id) { this.rows.delete(rid); entriesRemoved++; }
    }
    this.relations = this.relations.filter((r) => r.tenantId !== id);
    for (const [oid, o] of [...this.coldOrphans.entries()]) {
      if (o.tenantId === id) this.coldOrphans.delete(oid);
    }
    for (const [tk, v] of [...this.tokens.entries()]) {
      if (v.tenantId === id) this.tokens.delete(tk);
    }
    this.tenants.delete(id);
    return { deleted: true, entriesRemoved };
  }

  async listTenantTokens(tenantId: string) {
    return [...this.tokens.entries()]
      .filter(([, v]) => v.tenantId === tenantId)
      .map(([plain, v]) => ({
        tokenHash: this.fakeHash(plain),
        label: v.label,
        createdByUserId: v.createdByUserId,
        projectId: v.projectId,
        createdAt: new Date(),
        lastUsedAt: null,
        revoked: v.revoked,
      }));
  }

  // ─── Users + sessions ───────────────────────────────────────────────────

  async createUser(args: { username: string; passwordHash: string; role: "admin" | "user"; tenantId: string | null }) {
    const id = ulid();
    const row = {
      id,
      username: args.username,
      passwordHash: args.passwordHash,
      role: args.role,
      tenantId: args.tenantId,
      createdAt: new Date(),
      lastLoginAt: null,
    };
    this.users.set(id, row);
    return { id, username: args.username, role: args.role, tenantId: args.tenantId, createdAt: row.createdAt };
  }

  async findUserByUsername(username: string) {
    for (const u of this.users.values()) {
      if (u.username === username) {
        return {
          id: u.id,
          username: u.username,
          passwordHash: u.passwordHash,
          role: u.role,
          tenantId: u.tenantId,
        };
      }
    }
    return null;
  }

  async findUserById(id: string) {
    const u = this.users.get(id);
    if (!u) return null;
    return { id: u.id, username: u.username, role: u.role, tenantId: u.tenantId };
  }

  async listUsers() {
    return [...this.users.values()].map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      tenantId: u.tenantId,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    }));
  }

  async deleteUser(id: string) {
    return this.users.delete(id);
  }

  async setUserRole(id: string, role: "admin" | "user", tenantId: string | null) {
    const u = this.users.get(id);
    if (!u) return false;
    u.role = role;
    u.tenantId = tenantId;
    return true;
  }

  async countAdmins() {
    let n = 0;
    for (const u of this.users.values()) if (u.role === "admin") n++;
    return n;
  }

  async createSession(userId: string, ttlMs: number) {
    const token = "ns_test_" + Math.random().toString(36).slice(2, 18);
    const expiresAt = new Date(Date.now() + ttlMs);
    this.sessions.set(token, { userId, expiresAt });
    const u = this.users.get(userId);
    if (u) u.lastLoginAt = new Date();
    return { token, expiresAt };
  }

  async resolveSession(plaintext: string) {
    const s = this.sessions.get(plaintext);
    if (!s || s.expiresAt < new Date()) return null;
    const u = this.users.get(s.userId);
    if (!u) return null;
    return {
      user: { id: u.id, username: u.username, role: u.role, tenantId: u.tenantId },
    };
  }

  async revokeSession(plaintext: string) {
    return this.sessions.delete(plaintext);
  }

  // ─── Audit log ────────────────────────────────────────────────────────
  auditEntries: Array<{
    id: number;
    ts: Date;
    actorUserId: string | null;
    actorLabel: string;
    action: string;
    target: string | null;
    metadata: Record<string, unknown> | null;
    requestIp: string | null;
  }> = [];

  async writeAudit(entry: {
    actorUserId?: string | null;
    actorLabel: string;
    action: string;
    target?: string | null;
    metadata?: Record<string, unknown>;
    requestIp?: string | null;
  }) {
    this.auditEntries.push({
      id: this.auditEntries.length + 1,
      ts: new Date(),
      actorUserId: entry.actorUserId ?? null,
      actorLabel: entry.actorLabel,
      action: entry.action,
      target: entry.target ?? null,
      metadata: entry.metadata ?? null,
      requestIp: entry.requestIp ?? null,
    });
  }

  async listAuditLog(opts: { limit?: number } = {}) {
    return [...this.auditEntries].reverse().slice(0, opts.limit ?? 200);
  }

  // ─── Projects ───────────────────────────────────────────────────────────

  async createProject(args: { id: string; name: string; ownerUserId: string; ownerTenantId: string }) {
    const row = { ...args, createdAt: new Date() };
    this.projects.set(args.id, row);
    const m = new Map<string, { role: string; joinedAt: Date }>();
    m.set(args.ownerUserId, { role: "owner", joinedAt: new Date() });
    this.projectMembers.set(args.id, m);
    return row;
  }

  async getProject(id: string) {
    return this.projects.get(id) ?? null;
  }

  async listProjectsForUser(userId: string) {
    const out: Array<{ id: string; name: string; role: string; ownerUserId: string; ownerTenantId: string; createdAt: Date }> = [];
    for (const p of this.projects.values()) {
      const m = this.projectMembers.get(p.id)?.get(userId);
      if (m) out.push({ ...p, role: m.role });
    }
    return out;
  }

  async listProjectMembers(projectId: string) {
    const m = this.projectMembers.get(projectId);
    if (!m) return [];
    return [...m.entries()].map(([userId, v]) => {
      const u = this.users.get(userId);
      return {
        userId,
        username: u?.username ?? "(deleted)",
        tenantId: u?.tenantId ?? null,
        role: v.role,
        joinedAt: v.joinedAt,
      };
    });
  }

  async addProjectMember(projectId: string, userId: string, role: "owner" | "member") {
    let m = this.projectMembers.get(projectId);
    if (!m) {
      m = new Map();
      this.projectMembers.set(projectId, m);
    }
    if (m.has(userId)) return false;
    m.set(userId, { role, joinedAt: new Date() });
    return true;
  }

  async removeProjectMember(projectId: string, userId: string) {
    const removed = this.projectMembers.get(projectId)?.delete(userId) ?? false;
    let tokensRevoked = 0;
    if (removed) {
      for (const v of this.tokens.values()) {
        if (v.projectId === projectId && v.createdByUserId === userId && !v.revoked) {
          v.revoked = true;
          tokensRevoked++;
        }
      }
    }
    return { removed, tokensRevoked };
  }

  async getProjectMembership(projectId: string, userId: string) {
    const v = this.projectMembers.get(projectId)?.get(userId);
    return v ? { role: v.role } : null;
  }

  async deleteProject(id: string) {
    if (!this.projects.has(id)) return { deleted: false, entriesRemoved: 0 };
    let entriesRemoved = 0;
    for (const [eid, r] of [...this.rows.entries()]) {
      if (r.projectId === id) { this.rows.delete(eid); entriesRemoved++; }
    }
    this.relations = this.relations.filter((r) => r.projectId !== id);
    for (const [tk, v] of [...this.tokens.entries()]) {
      if (v.projectId === id) v.revoked = true; // revoke (don't delete history)
    }
    this.projectMembers.delete(id);
    this.projects.delete(id);
    return { deleted: true, entriesRemoved };
  }
}

export class FakeColdStore {
  vectors = new Map<
    string,
    {
      id: string;
      tenantId: string;
      projectId: string | null;
      namespace: string;
      embedding: number[];
      payload: Record<string, unknown>;
    }
  >();
  /** Set true to make every operation throw, simulating Qdrant being down. */
  fail = false;

  async ping(): Promise<boolean> { return !this.fail; }

  async upsert(args: {
    tenantId: string;
    projectId?: string | null;
    id: string;
    namespace: string;
    embedding: number[];
    payload: Record<string, unknown>;
  }) {
    if (this.fail) throw new Error("cold-store unavailable");
    this.vectors.set(args.id, { ...args, projectId: args.projectId ?? null });
  }

  async search(args: {
    tenantId: string;
    projectId?: string | null;
    namespace: string;
    embedding: number[];
    k: number;
  }) {
    if (this.fail) throw new Error("cold-store unavailable");
    const projectId = args.projectId ?? null;
    const cosine = (a: number[], b: number[]) => {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        dot += a[i]! * b[i]!;
        na += a[i]! * a[i]!;
        nb += b[i]! * b[i]!;
      }
      return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
    };
    return [...this.vectors.values()]
      .filter((v) => v.tenantId === args.tenantId && v.namespace === args.namespace)
      .filter((v) => (v.projectId ?? null) === projectId)
      .map((v) => ({ id: v.id, score: cosine(v.embedding, args.embedding), payload: v.payload }))
      .sort((a, b) => b.score - a.score)
      .slice(0, args.k);
  }

  async delete(
    tenantId: string,
    namespace: string,
    id: string,
    projectId: string | null = null,
  ): Promise<void> {
    if (this.fail) throw new Error("cold-store unavailable");
    const v = this.vectors.get(id);
    if (
      v &&
      v.tenantId === tenantId &&
      v.namespace === namespace &&
      (v.projectId ?? null) === projectId
    ) {
      this.vectors.delete(id);
    }
  }

  async deleteAllForTenant(tenantId: string): Promise<string[]> {
    if (this.fail) return [];
    const dropped = new Set<string>();
    for (const [id, v] of [...this.vectors.entries()]) {
      if (v.tenantId === tenantId && v.projectId == null) {
        this.vectors.delete(id);
        dropped.add(`novamem_${tenantId}_${v.namespace}`);
      }
    }
    return [...dropped];
  }

  async deleteAllForProject(projectId: string): Promise<string[]> {
    if (this.fail) return [];
    const dropped = new Set<string>();
    for (const [id, v] of [...this.vectors.entries()]) {
      if (v.projectId === projectId) {
        this.vectors.delete(id);
        dropped.add(`novamem_p_${projectId}_${v.namespace}`);
      }
    }
    return [...dropped];
  }
}

export class FakeGraphStore {
  // Edges keyed by `${tenantId}:${projectId ?? "_"}:${fromId}` so cross-
  // tenant + cross-project traversal is structurally impossible — same
  // approach as the real graph store's tenant + project node properties.
  edges = new Map<
    string,
    Array<{ tenantId: string; projectId: string | null; to: string; strength: number }>
  >();
  connected = true;

  private key(tenantId: string, projectId: string | null, id: string): string {
    return `${tenantId}:${projectId ?? "_"}:${id}`;
  }

  isConnected(): boolean { return this.connected; }
  async ping(): Promise<boolean> { return this.connected; }

  async addEdge(
    tenantId: string,
    from: string,
    to: string,
    _relation: string,
    strength = 1,
    projectId: string | null = null,
  ): Promise<void> {
    const k = this.key(tenantId, projectId, from);
    const cur = this.edges.get(k) ?? [];
    cur.push({ tenantId, projectId, to, strength });
    this.edges.set(k, cur);
  }

  async addEdgesBatch(
    tenantId: string,
    from: string,
    edges: Array<{ to: string; relation: string; strength?: number }>,
    projectId: string | null = null,
  ): Promise<void> {
    for (const e of edges) {
      await this.addEdge(tenantId, from, e.to, e.relation, e.strength ?? 1, projectId);
    }
  }

  async removeNode(tenantId: string, id: string): Promise<void> {
    for (const k of [...this.edges.keys()]) {
      if (k.startsWith(`${tenantId}:`) && k.endsWith(`:${id}`)) this.edges.delete(k);
    }
    for (const [k, list] of this.edges) {
      this.edges.set(k, list.filter((e) => e.to !== id));
    }
  }

  async neighbors(
    tenantId: string,
    seedId: string,
    _depth = 1,
    k = 10,
    projectId: string | null = null,
  ): Promise<Array<{ id: string; score: number }>> {
    const cur = this.edges.get(this.key(tenantId, projectId, seedId)) ?? [];
    return cur.slice(0, k).map((e) => ({ id: e.to, score: e.strength }));
  }

  async edgeCount(): Promise<number | null> {
    if (!this.connected) return null;
    let n = 0;
    for (const list of this.edges.values()) n += list.length;
    return n;
  }

  async removeAllForTenant(tenantId: string): Promise<boolean> {
    if (!this.connected) return false;
    for (const [k, list] of [...this.edges.entries()]) {
      if (k.startsWith(`${tenantId}:`)) this.edges.delete(k);
      else this.edges.set(k, list.filter((e) => e.tenantId !== tenantId));
    }
    return true;
  }

  async removeAllForProject(projectId: string): Promise<boolean> {
    if (!this.connected) return false;
    for (const [k, list] of [...this.edges.entries()]) {
      if (k.includes(`:${projectId}:`)) this.edges.delete(k);
      else this.edges.set(k, list.filter((e) => e.projectId !== projectId));
    }
    return true;
  }
}

export class FakeEmbedder implements Embedder {
  readonly dimensions = 4;
  /** Maps content text → embedding for predictable cosine results. */
  table = new Map<string, number[]>();

  async embed(input: string | string[]): Promise<number[][]> {
    const arr = Array.isArray(input) ? input : [input];
    return arr.map((s) => this.table.get(s) ?? this.deterministic(s));
  }

  /** Cheap stable hash → 4-dim unit vector so different strings get
   *  different but consistent embeddings without needing a real model. */
  private deterministic(s: string): number[] {
    const v = [0, 0, 0, 0];
    for (let i = 0; i < s.length; i++) {
      v[i % 4] = (v[i % 4] ?? 0) + s.charCodeAt(i);
    }
    const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

/** Convenience cast helpers — the engine uses concrete class types so we
 *  cast our fakes through `unknown`. The structural surface matches. */
export const asWarm = (f: FakeWarmStore): WarmStore => f as unknown as WarmStore;
export const asCold = (f: FakeColdStore): ColdStore => f as unknown as ColdStore;
export const asGraph = (f: FakeGraphStore): GraphStore => f as unknown as GraphStore;
