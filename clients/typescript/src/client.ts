// Client, Management and Admin: the 41 operations, each a thin call through
// the one transport. Op names, verbs, paths and local validation are
// transcribed from clients/go, the reference implementation (ADR 0009).

import { NovamemError } from "./errors.js";
import {
  Transport,
  type CallOptions,
  type ClientOptions,
} from "./transport.js";
import type * as t from "./types.js";

const seg = encodeURIComponent;
const blank = (s: string | undefined | null) => !(s ?? "").trim();

/** Drops unset and empty-string fields: the server's schemas are strict,
 * and an empty optional means "not given", as it does in every SDK. */
function clean<T extends object>(o: T | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o ?? {}))
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out;
}

/** A degraded answer with no results is an outage wearing the costume of an
 * empty result set. A degraded answer WITH results is real data. */
function degradedEmpty(op: string, body: any): void {
  if (
    body &&
    body.degraded &&
    !(Array.isArray(body.results) && body.results.length)
  ) {
    throw new NovamemError({
      op,
      statusCode: 200,
      message:
        "store answered degraded with no results, so this is not evidence of absence",
      unavailable: true,
      retryable: true,
    });
  }
}

abstract class Base {
  protected readonly t: Transport;

  /** Nothing is read from the environment. Safe to share. */
  constructor(options: ClientOptions) {
    this.t = new Transport(options);
  }

  toJSON(): object {
    return { baseUrl: this.t.baseUrl, token: "[redacted]" };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `${this.constructor.name} { baseUrl: '${this.t.baseUrl}', token: [redacted] }`;
  }
}

/** The data-plane operations an agent needs. Project and token
 * administration live on Management and Admin, so an agent holding a Client
 * cannot perform them by accident. */
export class Client extends Base {
  /** Durable write with semantic dedup, in-place update and supersession.
   * A declined worthiness gate is not an error: check `result.id`. */
  async capture(
    request: t.CaptureRequest,
    o: CallOptions = {}
  ): Promise<t.CaptureResult> {
    if (blank(request?.content))
      throw new NovamemError({ op: "capture", message: "content is required" });
    return this.t.call("capture", "POST", "/v1/capture", {
      body: clean(request),
      signal: o.signal,
    });
  }

  async search(
    request: t.SearchRequest,
    o: CallOptions = {}
  ): Promise<t.SearchResult> {
    if (blank(request?.query))
      throw new NovamemError({ op: "search", message: "query is required" });
    const body = await this.t.call("search", "POST", "/v1/search", {
      body: clean(request),
      signal: o.signal,
    });
    degradedEmpty("search", body);
    return body;
  }

  async recent(
    request: t.RecentRequest = {},
    o: CallOptions = {}
  ): Promise<t.EntryList> {
    const body = await this.t.call("recent", "POST", "/v1/recent", {
      body: clean(request),
      signal: o.signal,
    });
    degradedEmpty("recent", body);
    return body;
  }

  /** `recent` over the last 24 hours. */
  async today(
    request: t.RecentRequest = {},
    o: CallOptions = {}
  ): Promise<t.EntryList> {
    return this.recent(
      { ...request, since: new Date(Date.now() - 24 * 3600 * 1000) },
      o
    );
  }

  async neighbors(
    request: t.NeighborsRequest,
    o: CallOptions = {}
  ): Promise<t.SearchResult> {
    if (blank(request?.id))
      throw new NovamemError({ op: "neighbors", message: "id is required" });
    const body = await this.t.call("neighbors", "POST", "/v1/neighbors", {
      body: clean(request),
      signal: o.signal,
    });
    degradedEmpty("neighbors", body);
    return body;
  }

  /** Rewrite an entry in place, preserving its id, hits and edges. */
  async update(
    id: string,
    request: t.UpdateRequest = {},
    o: CallOptions = {}
  ): Promise<t.UpdateResult> {
    if (blank(id))
      throw new NovamemError({ op: "update", message: "id is required" });
    const body = await this.t.call(
      "update",
      "PUT",
      "/v1/memories/" + seg(id.trim()),
      {
        body: clean(request),
        signal: o.signal,
      }
    );
    return body && !body.id ? { ...body, id: id.trim() } : body;
  }

  /** Never reports success on a failed delete. An id that is not in your
   * scope comes back `deleted: false` with no error. */
  async forget(
    request: t.ForgetRequest,
    o: CallOptions = {}
  ): Promise<t.ForgetResult> {
    if (blank(request?.id))
      throw new NovamemError({ op: "forget", message: "id is required" });
    try {
      return await this.t.call("forget", "POST", "/v1/forget", {
        body: clean(request),
        signal: o.signal,
      });
    } catch (e) {
      if (e instanceof NovamemError && e.notFound)
        return { deleted: false, coldDeleteOk: true };
      throw e;
    }
  }

  /** Unconditional store: no worthiness gate, no dedup pass. */
  async remember(
    request: t.CaptureRequest,
    o: CallOptions = {}
  ): Promise<t.RememberResult> {
    if (blank(request?.content))
      throw new NovamemError({
        op: "remember",
        message: "content is required",
      });
    return this.t.call("remember", "POST", "/v1/remember", {
      body: clean(request),
      signal: o.signal,
    });
  }

  async context(
    request: t.ContextRequest,
    o: CallOptions = {}
  ): Promise<t.SearchResult> {
    if (blank(request?.message))
      throw new NovamemError({ op: "context", message: "message is required" });
    return this.t.call("context", "POST", "/v1/context", {
      body: clean(request),
      signal: o.signal,
    });
  }

  async sessionRecap(
    request: t.SessionRecapRequest,
    o: CallOptions = {}
  ): Promise<t.SessionRecapResult> {
    return this.t.call("session-recap", "POST", "/v1/session-recap", {
      body: clean(request),
      signal: o.signal,
    });
  }

  /** A notFound error here means the server's observer is disabled. */
  async contextPrefix(
    project?: string,
    o: CallOptions = {}
  ): Promise<t.ContextPrefix> {
    return this.t.call("context-prefix", "GET", "/v1/context-prefix", {
      query: { project },
      signal: o.signal,
    });
  }

  async stats(o: CallOptions = {}): Promise<t.Stats> {
    return this.t.call("stats", "GET", "/v1/stats", { signal: o.signal });
  }

  /** A served `{ok: false}` — including /health's own 503 — is an answer
   * ("not healthy"), not an outage. */
  async health(o: CallOptions = {}): Promise<boolean> {
    try {
      const body = await this.t.call("health", "GET", "/health", {
        signal: o.signal,
      });
      return Boolean(body?.ok);
    } catch (e) {
      if (e instanceof NovamemError && e.statusCode === 503) return false;
      throw e;
    }
  }
}

/** The caller's own /v1/me/* surface: tokens, projects and members, the
 * active project, and the maintenance endpoints. */
export class Management extends Base {
  async mintToken(
    request: t.MintTokenRequest = {},
    o: CallOptions = {}
  ): Promise<t.MintedToken> {
    return this.t.call("mint-token", "POST", "/v1/me/tokens", {
      body: clean(request),
      signal: o.signal,
    });
  }

  async listTokens(o: CallOptions = {}): Promise<t.TokenList> {
    return this.t.call("list-tokens", "GET", "/v1/me/tokens", {
      signal: o.signal,
    });
  }

  async revokeToken(
    hash: string,
    o: CallOptions = {}
  ): Promise<t.TokenDeleted> {
    if (blank(hash))
      throw new NovamemError({
        op: "revoke-token",
        message: "tokenHash is required",
      });
    return this.t.call(
      "revoke-token",
      "DELETE",
      "/v1/me/tokens/" + seg(hash.trim()),
      { signal: o.signal }
    );
  }

  async listProjects(o: CallOptions = {}): Promise<t.ProjectList> {
    return this.t.call("list-projects", "GET", "/v1/me/projects", {
      signal: o.signal,
    });
  }

  async createProject(name: string, o: CallOptions = {}): Promise<t.Project> {
    if (blank(name))
      throw new NovamemError({
        op: "create-project",
        message: "name is required",
      });
    return this.t.call("create-project", "POST", "/v1/me/projects", {
      body: { name },
      signal: o.signal,
    });
  }

  async deleteProject(
    id: string,
    o: CallOptions = {}
  ): Promise<t.ProjectDeleted> {
    if (blank(id))
      throw new NovamemError({
        op: "delete-project",
        message: "id is required",
      });
    return this.t.call(
      "delete-project",
      "DELETE",
      "/v1/me/projects/" + seg(id),
      { signal: o.signal }
    );
  }

  async listProjectMembers(
    id: string,
    o: CallOptions = {}
  ): Promise<t.MemberList> {
    if (blank(id))
      throw new NovamemError({ op: "list-members", message: "id is required" });
    return this.t.call(
      "list-members",
      "GET",
      `/v1/me/projects/${seg(id)}/members`,
      { signal: o.signal }
    );
  }

  /** Adds a user by their EXACT sign-in email (the wire field is named
   * "username" for historical reasons). `role` is "member" or "owner". */
  async addProjectMember(
    id: string,
    email: string,
    role?: string,
    o: CallOptions = {}
  ): Promise<t.MemberAdded> {
    if (blank(id) || blank(email))
      throw new NovamemError({
        op: "add-member",
        message: "id and email are required",
      });
    return this.t.call(
      "add-member",
      "POST",
      `/v1/me/projects/${seg(id)}/members`,
      {
        body: clean({ username: email, role }),
        signal: o.signal,
      }
    );
  }

  async removeProjectMember(
    id: string,
    userId: string,
    o: CallOptions = {}
  ): Promise<t.MemberRemoved> {
    if (blank(id) || blank(userId)) {
      throw new NovamemError({
        op: "remove-member",
        message: "id and userId are required",
      });
    }
    return this.t.call(
      "remove-member",
      "DELETE",
      `/v1/me/projects/${seg(id)}/members/${seg(userId)}`,
      {
        signal: o.signal,
      }
    );
  }

  async removeProjectMemberByUsername(
    id: string,
    username: string,
    o: CallOptions = {}
  ): Promise<t.MemberRemoved> {
    if (blank(id) || blank(username)) {
      throw new NovamemError({
        op: "remove-member",
        message: "id and username are required",
      });
    }
    const { members } = await this.listProjectMembers(id, o);
    const m = members.find((x) => x.username === username && x.userId);
    if (!m)
      throw new NovamemError({
        op: "remove-member",
        message: `unknown member '${username}'`,
      });
    return this.removeProjectMember(id, m.userId!, o);
  }

  async activeProject(o: CallOptions = {}): Promise<t.ActiveProject> {
    return this.t.call("active-project", "GET", "/v1/me/active-project", {
      signal: o.signal,
    });
  }

  async setActiveProject(
    project: string,
    o: CallOptions = {}
  ): Promise<t.ActiveProject> {
    if (blank(project))
      throw new NovamemError({
        op: "set-active-project",
        message: "project is required",
      });
    return this.t.call("set-active-project", "PUT", "/v1/me/active-project", {
      body: { project },
      signal: o.signal,
    });
  }

  async clearActiveProject(o: CallOptions = {}): Promise<void> {
    await this.t.call(
      "clear-active-project",
      "DELETE",
      "/v1/me/active-project",
      { expectBody: false, signal: o.signal }
    );
  }

  async decay(
    effectiveDays?: number,
    o: CallOptions = {}
  ): Promise<t.DecayResult> {
    return this.t.call("decay", "POST", "/v1/decay", {
      body: clean({ effectiveDays }),
      signal: o.signal,
    });
  }

  async hygiene(k?: number, o: CallOptions = {}): Promise<t.HygieneReport> {
    return this.t.call("hygiene", "POST", "/v1/hygiene", {
      body: clean({ k }),
      signal: o.signal,
    });
  }

  async evaluate(
    suite?: string,
    o: CallOptions = {}
  ): Promise<t.EvaluateReport> {
    return this.t.call("evaluate", "POST", "/v1/evaluate", {
      body: clean({ suite }),
      signal: o.signal,
    });
  }

  async adoption(
    client?: string,
    o: CallOptions = {}
  ): Promise<t.AdoptionReport> {
    return this.t.call("adoption", "POST", "/v1/adoption", {
      body: clean({ client }),
      signal: o.signal,
    });
  }

  /** Throws a NovamemError with code "observer_disabled" when the server's
   * observer is off — a configuration answer, not an outage. */
  async observe(
    project?: string,
    limit?: number,
    o: CallOptions = {}
  ): Promise<t.ObserveResult> {
    try {
      return await this.t.call("observe", "POST", "/v1/observe", {
        body: clean({ project, limit }),
        signal: o.signal,
      });
    } catch (e) {
      if (e instanceof NovamemError && e.statusCode === 503) {
        throw new NovamemError({
          op: "observe",
          statusCode: 503,
          code: "observer_disabled",
          message: "observer disabled",
        });
      }
      throw e;
    }
  }

  async changes(
    since?: string,
    afterSeq?: number,
    limit?: number,
    o: CallOptions = {}
  ): Promise<t.ChangeFeed> {
    return this.t.call("changes", "GET", "/v1/me/changes", {
      query: { since, afterSeq, limit },
      signal: o.signal,
    });
  }

  async usage(o: CallOptions = {}): Promise<t.Usage> {
    return this.t.call("usage", "GET", "/v1/me/usage", { signal: o.signal });
  }

  /** One page, oldest first. Pass `nextAfterId` back as `afterId` until a
   * page comes back with no entries. */
  async export(
    afterId?: string,
    limit?: number,
    o: CallOptions = {}
  ): Promise<t.ExportPage> {
    return this.t.call("export", "GET", "/v1/me/export", {
      query: { afterId, limit },
      signal: o.signal,
    });
  }

  /** Store 1-200 entries (an export page's `entries` fit as-is),
   * unconditionally, deduplicated by content hash. */
  async import(
    entries: Array<Record<string, unknown>>,
    o: CallOptions = {}
  ): Promise<t.ImportResult> {
    if (!entries?.length)
      throw new NovamemError({ op: "import", message: "entries are required" });
    return this.t.call("import", "POST", "/v1/me/import", {
      body: { entries },
      signal: o.signal,
    });
  }
}

/** Server administration, with an admin user's bearer: provisioning one
 * novamem user per agent, and revoking leaked tokens. */
export class Admin extends Base {
  async provisionUser(
    request: t.ProvisionUserRequest,
    o: CallOptions = {}
  ): Promise<t.ProvisionedUser> {
    if (blank(request?.email) || !request?.password) {
      throw new NovamemError({
        op: "provision-user",
        message: "email and password are required",
      });
    }
    return this.t.call("provision-user", "POST", "/v1/admin/users", {
      body: clean(request),
      signal: o.signal,
    });
  }

  /** Revoke a bearer by presenting its plaintext. */
  async revokeUserToken(
    token: string,
    o: CallOptions = {}
  ): Promise<t.RevokeResult> {
    if (blank(token))
      throw new NovamemError({
        op: "revoke-user-token",
        message: "token is required",
      });
    return this.t.call("revoke-user-token", "POST", "/v1/admin/tokens/revoke", {
      body: { token },
      signal: o.signal,
    });
  }

  async listUsers(o: CallOptions = {}): Promise<t.AdminUserList> {
    return this.t.call("list-users", "GET", "/v1/admin/users", {
      signal: o.signal,
    });
  }

  async previewDeleteUser(
    id: string,
    o: CallOptions = {}
  ): Promise<t.UserDeletionPreview> {
    if (blank(id))
      throw new NovamemError({
        op: "preview-delete-user",
        message: "userID is required",
      });
    return this.t.call(
      "preview-delete-user",
      "DELETE",
      "/v1/admin/users/" + seg(id),
      {
        query: { dryRun: true },
        signal: o.signal,
      }
    );
  }

  async deleteUser(id: string, o: CallOptions = {}): Promise<t.UserDeletion> {
    if (blank(id))
      throw new NovamemError({
        op: "delete-user",
        message: "userID is required",
      });
    return this.t.call("delete-user", "DELETE", "/v1/admin/users/" + seg(id), {
      signal: o.signal,
    });
  }

  /** `null` (or omitting a limit) clears that override. */
  async setUserQuota(
    id: string,
    maxEntries?: number | null,
    writesPerMinute?: number | null,
    o: CallOptions = {}
  ): Promise<t.QuotaResult> {
    if (blank(id))
      throw new NovamemError({
        op: "set-user-quota",
        message: "userID is required",
      });
    return this.t.call(
      "set-user-quota",
      "PUT",
      `/v1/admin/users/${seg(id)}/quota`,
      {
        body: {
          maxEntries: maxEntries ?? null,
          writesPerMinute: writesPerMinute ?? null,
        },
        signal: o.signal,
      }
    );
  }
}
