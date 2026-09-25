package com.azrtydxb.novamem;

import com.azrtydxb.novamem.types.Types.ActiveProject;
import com.azrtydxb.novamem.types.Types.AdoptionReport;
import com.azrtydxb.novamem.types.Types.ChangeFeed;
import com.azrtydxb.novamem.types.Types.DecayResult;
import com.azrtydxb.novamem.types.Types.EvaluateReport;
import com.azrtydxb.novamem.types.Types.ExportPage;
import com.azrtydxb.novamem.types.Types.HygieneReport;
import com.azrtydxb.novamem.types.Types.ImportResult;
import com.azrtydxb.novamem.types.Types.MemberAdded;
import com.azrtydxb.novamem.types.Types.MemberList;
import com.azrtydxb.novamem.types.Types.MemberListMembersItem;
import com.azrtydxb.novamem.types.Types.MemberRemoved;
import com.azrtydxb.novamem.types.Types.MintTokenRequest;
import com.azrtydxb.novamem.types.Types.MintedToken;
import com.azrtydxb.novamem.types.Types.ObserveResult;
import com.azrtydxb.novamem.types.Types.Project;
import com.azrtydxb.novamem.types.Types.ProjectDeleted;
import com.azrtydxb.novamem.types.Types.ProjectList;
import com.azrtydxb.novamem.types.Types.TokenDeleted;
import com.azrtydxb.novamem.types.Types.TokenList;
import com.azrtydxb.novamem.types.Types.Usage;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The caller's own /v1/me/* surface: tokens, projects and members, the active project, and the
 * maintenance endpoints. Every operation has a blocking and an {@code …Async} form.
 */
public final class Management extends Base {
  /**
   * A management client for the given config.
   *
   * @throws IllegalArgumentException when config is null
   */
  public Management(NovamemConfig config) {
    super(config);
  }

  /** Mints a token for the caller. request may be null. */
  public MintedToken mintToken(MintTokenRequest request) {
    return await(mintTokenAsync(request));
  }

  /** See {@link #mintToken}. */
  public CompletableFuture<MintedToken> mintTokenAsync(MintTokenRequest request) {
    Object body = request == null ? Map.of() : request;
    return as(
        "mint-token",
        transport.call("mint-token", "POST", "/v1/me/tokens", body, null, true),
        MintedToken.class,
        false);
  }

  /** The caller's tokens. */
  public TokenList listTokens() {
    return await(listTokensAsync());
  }

  /** See {@link #listTokens}. */
  public CompletableFuture<TokenList> listTokensAsync() {
    return as(
        "list-tokens",
        transport.call("list-tokens", "GET", "/v1/me/tokens", null, null, true),
        TokenList.class,
        false);
  }

  /** Revokes one of the caller's tokens by its hash. */
  public TokenDeleted revokeToken(String hash) {
    return await(revokeTokenAsync(hash));
  }

  /** See {@link #revokeToken}. */
  public CompletableFuture<TokenDeleted> revokeTokenAsync(String hash) {
    if (blank(hash)) {
      return invalid("revoke-token", "tokenHash is required");
    }
    return as(
        "revoke-token",
        transport.call(
            "revoke-token", "DELETE", "/v1/me/tokens/" + seg(hash.trim()), null, null, true),
        TokenDeleted.class,
        false);
  }

  /** The projects the caller belongs to. */
  public ProjectList listProjects() {
    return await(listProjectsAsync());
  }

  /** See {@link #listProjects}. */
  public CompletableFuture<ProjectList> listProjectsAsync() {
    return as(
        "list-projects",
        transport.call("list-projects", "GET", "/v1/me/projects", null, null, true),
        ProjectList.class,
        false);
  }

  /** Creates a project owned by the caller. */
  public Project createProject(String name) {
    return await(createProjectAsync(name));
  }

  /** See {@link #createProject}. */
  public CompletableFuture<Project> createProjectAsync(String name) {
    if (blank(name)) {
      return invalid("create-project", "name is required");
    }
    return as(
        "create-project",
        transport.call(
            "create-project", "POST", "/v1/me/projects", fields("name", name), null, true),
        Project.class,
        false);
  }

  /** Deletes a project and its entries. */
  public ProjectDeleted deleteProject(String id) {
    return await(deleteProjectAsync(id));
  }

  /** See {@link #deleteProject}. */
  public CompletableFuture<ProjectDeleted> deleteProjectAsync(String id) {
    if (blank(id)) {
      return invalid("delete-project", "id is required");
    }
    return as(
        "delete-project",
        transport.call("delete-project", "DELETE", "/v1/me/projects/" + seg(id), null, null, true),
        ProjectDeleted.class,
        false);
  }

  /** A project's members. */
  public MemberList listProjectMembers(String id) {
    return await(listProjectMembersAsync(id));
  }

  /** See {@link #listProjectMembers}. */
  public CompletableFuture<MemberList> listProjectMembersAsync(String id) {
    if (blank(id)) {
      return invalid("list-members", "id is required");
    }
    return as(
        "list-members",
        transport.call(
            "list-members", "GET", "/v1/me/projects/" + seg(id) + "/members", null, null, true),
        MemberList.class,
        false);
  }

  /**
   * Adds a user by their EXACT sign-in email (the wire field is named "username" for historical
   * reasons). role is "member" or "owner", or null for the server's default.
   */
  public MemberAdded addProjectMember(String id, String email, String role) {
    return await(addProjectMemberAsync(id, email, role));
  }

  /** See {@link #addProjectMember}. */
  public CompletableFuture<MemberAdded> addProjectMemberAsync(
      String id, String email, String role) {
    if (blank(id) || blank(email)) {
      return invalid("add-member", "id and email are required");
    }
    return as(
        "add-member",
        transport.call(
            "add-member",
            "POST",
            "/v1/me/projects/" + seg(id) + "/members",
            fields("username", email, "role", role),
            null,
            true),
        MemberAdded.class,
        false);
  }

  /** Removes a member by user id. */
  public MemberRemoved removeProjectMember(String id, String userId) {
    return await(removeProjectMemberAsync(id, userId));
  }

  /** See {@link #removeProjectMember}. */
  public CompletableFuture<MemberRemoved> removeProjectMemberAsync(String id, String userId) {
    if (blank(id) || blank(userId)) {
      return invalid("remove-member", "id and userId are required");
    }
    return as(
        "remove-member",
        transport.call(
            "remove-member",
            "DELETE",
            "/v1/me/projects/" + seg(id) + "/members/" + seg(userId),
            null,
            null,
            true),
        MemberRemoved.class,
        false);
  }

  /** Removes a member by username: two calls, a lookup and the removal. */
  public MemberRemoved removeProjectMemberByUsername(String id, String username) {
    return await(removeProjectMemberByUsernameAsync(id, username));
  }

  /**
   * See {@link #removeProjectMemberByUsername}. Cancelling it cancels whichever call is running.
   */
  public CompletableFuture<MemberRemoved> removeProjectMemberByUsernameAsync(
      String id, String username) {
    if (blank(id) || blank(username)) {
      return invalid("remove-member", "id and username are required");
    }
    CompletableFuture<MemberRemoved> out = new CompletableFuture<>();
    CompletableFuture<MemberList> lookup = listProjectMembersAsync(id);
    AtomicReference<CompletableFuture<?>> current = new AtomicReference<>(lookup);
    out.whenComplete(
        (r, e) -> {
          if (out.isCancelled()) {
            current.get().cancel(true);
          }
        });
    lookup.whenComplete(
        (list, e) -> {
          if (e != null) {
            out.completeExceptionally(Transport.unwrap(e));
            return;
          }
          List<MemberListMembersItem> members = list.members() == null ? List.of() : list.members();
          MemberListMembersItem m =
              members.stream()
                  .filter(x -> username.equals(x.username()) && !blank(x.userId()))
                  .findFirst()
                  .orElse(null);
          if (m == null) {
            out.completeExceptionally(
                new NovamemException("remove-member", "unknown member '" + username + "'"));
            return;
          }
          CompletableFuture<MemberRemoved> removal = removeProjectMemberAsync(id, m.userId());
          current.set(removal);
          if (out.isDone()) {
            removal.cancel(true);
          }
          removal.whenComplete(
              (r, e2) -> {
                if (e2 != null) {
                  out.completeExceptionally(Transport.unwrap(e2));
                } else {
                  out.complete(r);
                }
              });
        });
    return out;
  }

  /** The caller's active project. */
  public ActiveProject activeProject() {
    return await(activeProjectAsync());
  }

  /** See {@link #activeProject}. */
  public CompletableFuture<ActiveProject> activeProjectAsync() {
    return as(
        "active-project",
        transport.call("active-project", "GET", "/v1/me/active-project", null, null, true),
        ActiveProject.class,
        false);
  }

  /** Sets the caller's active project, by id or name. */
  public ActiveProject setActiveProject(String project) {
    return await(setActiveProjectAsync(project));
  }

  /** See {@link #setActiveProject}. */
  public CompletableFuture<ActiveProject> setActiveProjectAsync(String project) {
    if (blank(project)) {
      return invalid("set-active-project", "project is required");
    }
    return as(
        "set-active-project",
        transport.call(
            "set-active-project",
            "PUT",
            "/v1/me/active-project",
            fields("project", project),
            null,
            true),
        ActiveProject.class,
        false);
  }

  /** Clears the caller's active project. */
  public void clearActiveProject() {
    await(clearActiveProjectAsync());
  }

  /** See {@link #clearActiveProject}. */
  public CompletableFuture<Void> clearActiveProjectAsync() {
    return then(
        transport.call(
            "clear-active-project", "DELETE", "/v1/me/active-project", null, null, false),
        (r, e) -> {
          if (e != null) {
            throw rethrow(e);
          }
          return null;
        });
  }

  /** Runs tier decay now. effectiveDays may be null. */
  public DecayResult decay(Integer effectiveDays) {
    return await(decayAsync(effectiveDays));
  }

  /** See {@link #decay}. */
  public CompletableFuture<DecayResult> decayAsync(Integer effectiveDays) {
    return as(
        "decay",
        transport.call(
            "decay", "POST", "/v1/decay", fields("effectiveDays", effectiveDays), null, true),
        DecayResult.class,
        false);
  }

  /** A hygiene report. k may be null. */
  public HygieneReport hygiene(Integer k) {
    return await(hygieneAsync(k));
  }

  /** See {@link #hygiene}. */
  public CompletableFuture<HygieneReport> hygieneAsync(Integer k) {
    return as(
        "hygiene",
        transport.call("hygiene", "POST", "/v1/hygiene", fields("k", k), null, true),
        HygieneReport.class,
        false);
  }

  /** Runs a retrieval evaluation suite. suite may be null. */
  public EvaluateReport evaluate(String suite) {
    return await(evaluateAsync(suite));
  }

  /** See {@link #evaluate}. */
  public CompletableFuture<EvaluateReport> evaluateAsync(String suite) {
    return as(
        "evaluate",
        transport.call("evaluate", "POST", "/v1/evaluate", fields("suite", suite), null, true),
        EvaluateReport.class,
        false);
  }

  /** An adoption report for an agent client. client may be null. */
  public AdoptionReport adoption(String client) {
    return await(adoptionAsync(client));
  }

  /** See {@link #adoption}. */
  public CompletableFuture<AdoptionReport> adoptionAsync(String client) {
    return as(
        "adoption",
        transport.call("adoption", "POST", "/v1/adoption", fields("client", client), null, true),
        AdoptionReport.class,
        false);
  }

  /**
   * Runs the observer. Throws a NovamemException with code "observer_disabled" when the server's
   * observer is off — a configuration answer, not an outage. Both arguments may be null.
   */
  public ObserveResult observe(String project, Integer limit) {
    return await(observeAsync(project, limit));
  }

  /** See {@link #observe}. */
  public CompletableFuture<ObserveResult> observeAsync(String project, Integer limit) {
    return then(
        as(
            "observe",
            transport.call(
                "observe",
                "POST",
                "/v1/observe",
                fields("project", project, "limit", limit),
                null,
                true),
            ObserveResult.class,
            false),
        (r, e) -> {
          if (e instanceof NovamemException ne && ne.statusCode() == 503) {
            throw new NovamemException(
                "observe", "observer disabled", 503, "observer_disabled", false, false);
          }
          if (e != null) {
            throw rethrow(e);
          }
          return r;
        });
  }

  /**
   * The caller's change feed. since is an RFC 3339 timestamp (sent as UTC); every argument may be
   * null.
   */
  public ChangeFeed changes(String since, Long afterSeq, Integer limit) {
    return await(changesAsync(since, afterSeq, limit));
  }

  /** See {@link #changes}. */
  public CompletableFuture<ChangeFeed> changesAsync(String since, Long afterSeq, Integer limit) {
    Map<String, Object> q = new LinkedHashMap<>();
    q.put("since", since == null ? null : InstantCodec.normalize(since));
    q.put("afterSeq", afterSeq);
    q.put("limit", limit);
    return as(
        "changes",
        transport.call("changes", "GET", "/v1/me/changes", null, q, true),
        ChangeFeed.class,
        false);
  }

  /** The caller's usage and quota. */
  public Usage usage() {
    return await(usageAsync());
  }

  /** See {@link #usage}. */
  public CompletableFuture<Usage> usageAsync() {
    return as(
        "usage",
        transport.call("usage", "GET", "/v1/me/usage", null, null, true),
        Usage.class,
        false);
  }

  /**
   * One page, oldest first. Pass nextAfterId back as afterId until a page comes back with no
   * entries. Both arguments may be null.
   */
  public ExportPage export(String afterId, Integer limit) {
    return await(exportAsync(afterId, limit));
  }

  /** See {@link #export}. */
  public CompletableFuture<ExportPage> exportAsync(String afterId, Integer limit) {
    Map<String, Object> q = new LinkedHashMap<>();
    q.put("afterId", afterId);
    q.put("limit", limit);
    return as(
        "export",
        transport.call("export", "GET", "/v1/me/export", null, q, true),
        ExportPage.class,
        false);
  }

  /**
   * Stores 1-200 entries (an export page's entries fit as-is), unconditionally, deduplicated by
   * content hash. ("import" is a Java keyword.)
   */
  public ImportResult importEntries(List<?> entries) {
    return await(importEntriesAsync(entries));
  }

  /** See {@link #importEntries}. */
  public CompletableFuture<ImportResult> importEntriesAsync(List<?> entries) {
    if (entries == null || entries.isEmpty()) {
      return invalid("import", "entries are required");
    }
    return as(
        "import",
        transport.call("import", "POST", "/v1/me/import", Map.of("entries", entries), null, true),
        ImportResult.class,
        false);
  }
}
