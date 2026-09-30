package com.azrtydxb.novamem;

import com.azrtydxb.novamem.types.Types.CaptureRequest;
import com.azrtydxb.novamem.types.Types.CaptureResult;
import com.azrtydxb.novamem.types.Types.ContextPrefix;
import com.azrtydxb.novamem.types.Types.ContextRequest;
import com.azrtydxb.novamem.types.Types.EntryList;
import com.azrtydxb.novamem.types.Types.ForgetRequest;
import com.azrtydxb.novamem.types.Types.ForgetResult;
import com.azrtydxb.novamem.types.Types.NeighborsRequest;
import com.azrtydxb.novamem.types.Types.RecentRequest;
import com.azrtydxb.novamem.types.Types.RememberResult;
import com.azrtydxb.novamem.types.Types.SearchRequest;
import com.azrtydxb.novamem.types.Types.SearchResult;
import com.azrtydxb.novamem.types.Types.SessionRecapRequest;
import com.azrtydxb.novamem.types.Types.SessionRecapResult;
import com.azrtydxb.novamem.types.Types.Stats;
import com.azrtydxb.novamem.types.Types.UpdateRequest;
import com.azrtydxb.novamem.types.Types.UpdateResult;
import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.concurrent.CompletableFuture;

/**
 * The data-plane operations an agent needs. Project and token administration live on {@link
 * Management} and {@link Admin}, so an agent holding a Client cannot perform them by accident.
 *
 * <p>Every operation comes in two forms: a blocking one, and an {@code …Async} one returning a
 * CompletableFuture. Cancelling that future cancels the request.
 */
public final class Client extends Base {
  /**
   * A client for the given config.
   *
   * @throws IllegalArgumentException when config is null
   */
  public Client(NovamemConfig config) {
    super(config);
  }

  /** Durable write with semantic dedup. A declined worthiness gate is not an error: check id. */
  public CaptureResult capture(CaptureRequest request) {
    return await(captureAsync(request));
  }

  /** See {@link #capture}. */
  public CompletableFuture<CaptureResult> captureAsync(CaptureRequest request) {
    if (request == null || blank(request.content())) {
      return invalid("capture", "content is required");
    }
    return as(
        "capture",
        transport.call("capture", "POST", "/v1/capture", request, null, true),
        CaptureResult.class,
        false);
  }

  /** Ranked retrieval. A degraded answer with no results is an outage, not an empty result. */
  public SearchResult search(SearchRequest request) {
    return await(searchAsync(request));
  }

  /** See {@link #search}. */
  public CompletableFuture<SearchResult> searchAsync(SearchRequest request) {
    if (request == null || blank(request.query())) {
      return invalid("search", "query is required");
    }
    return as(
        "search",
        transport.call("search", "POST", "/v1/search", request, null, true),
        SearchResult.class,
        true);
  }

  /** The newest entries. request may be null. */
  public EntryList recent(RecentRequest request) {
    return await(recentAsync(request));
  }

  /** See {@link #recent}. */
  public CompletableFuture<EntryList> recentAsync(RecentRequest request) {
    RecentRequest r = request == null ? RecentRequest.builder().build() : request;
    return as(
        "recent",
        transport.call("recent", "POST", "/v1/recent", r, null, true),
        EntryList.class,
        true);
  }

  /** {@link #recent} over the last 24 hours. request may be null. */
  public EntryList today(RecentRequest request) {
    return await(todayAsync(request));
  }

  /** See {@link #today}. */
  public CompletableFuture<EntryList> todayAsync(RecentRequest request) {
    RecentRequest r = request == null ? RecentRequest.builder().build() : request;
    return recentAsync(r.toBuilder().since(Instant.now().minus(Duration.ofHours(24))).build());
  }

  /** Entries linked to the given one. */
  public SearchResult neighbors(NeighborsRequest request) {
    return await(neighborsAsync(request));
  }

  /** See {@link #neighbors}. */
  public CompletableFuture<SearchResult> neighborsAsync(NeighborsRequest request) {
    if (request == null || blank(request.id())) {
      return invalid("neighbors", "id is required");
    }
    return as(
        "neighbors",
        transport.call("neighbors", "POST", "/v1/neighbors", request, null, true),
        SearchResult.class,
        true);
  }

  /** Rewrite an entry in place, preserving its id, hits and edges. request may be null. */
  public UpdateResult update(String id, UpdateRequest request) {
    return await(updateAsync(id, request));
  }

  /** See {@link #update}. */
  public CompletableFuture<UpdateResult> updateAsync(String id, UpdateRequest request) {
    if (blank(id)) {
      return invalid("update", "id is required");
    }
    String trimmed = id.trim();
    Object body = request == null ? Collections.emptyMap() : request;
    return then(
        as(
            "update",
            transport.call("update", "PUT", "/v1/memories/" + seg(trimmed), body, null, true),
            UpdateResult.class,
            false),
        (r, e) -> {
          if (e != null) {
            throw rethrow(e);
          }
          return blank(r.id()) ? r.toBuilder().id(trimmed).build() : r;
        });
  }

  /**
   * Never reports success on a failed delete. An id that is not in your scope comes back with
   * deleted false and no exception.
   */
  public ForgetResult forget(ForgetRequest request) {
    return await(forgetAsync(request));
  }

  /** See {@link #forget}. */
  public CompletableFuture<ForgetResult> forgetAsync(ForgetRequest request) {
    if (request == null || blank(request.id())) {
      return invalid("forget", "id is required");
    }
    return then(
        as(
            "forget",
            transport.call("forget", "POST", "/v1/forget", request, null, true),
            ForgetResult.class,
            false),
        (r, e) -> {
          if (e instanceof NovamemException ne && ne.isNotFound()) {
            return ForgetResult.builder().deleted(false).coldDeleteOk(true).build();
          }
          if (e != null) {
            throw rethrow(e);
          }
          return r;
        });
  }

  /** Unconditional store: no worthiness gate, no dedup pass. */
  public RememberResult remember(CaptureRequest request) {
    return await(rememberAsync(request));
  }

  /** See {@link #remember}. */
  public CompletableFuture<RememberResult> rememberAsync(CaptureRequest request) {
    if (request == null || blank(request.content())) {
      return invalid("remember", "content is required");
    }
    return as(
        "remember",
        transport.call("remember", "POST", "/v1/remember", request, null, true),
        RememberResult.class,
        false);
  }

  /** The memories relevant to a message, for an agent's prompt. */
  public SearchResult context(ContextRequest request) {
    return await(contextAsync(request));
  }

  /** See {@link #context}. */
  public CompletableFuture<SearchResult> contextAsync(ContextRequest request) {
    if (request == null || blank(request.message())) {
      return invalid("context", "message is required");
    }
    return as(
        "context",
        transport.call("context", "POST", "/v1/context", request, null, true),
        SearchResult.class,
        false);
  }

  /** Saves a session's recap as separate entries. */
  public SessionRecapResult sessionRecap(SessionRecapRequest request) {
    return await(sessionRecapAsync(request));
  }

  /** See {@link #sessionRecap}. */
  public CompletableFuture<SessionRecapResult> sessionRecapAsync(SessionRecapRequest request) {
    Object body = request == null ? Collections.emptyMap() : request;
    return as(
        "session-recap",
        transport.call("session-recap", "POST", "/v1/session-recap", body, null, true),
        SessionRecapResult.class,
        false);
  }

  /** The observer's prefix. A not-found exception here means the observer is disabled. */
  public ContextPrefix contextPrefix(String project) {
    return await(contextPrefixAsync(project));
  }

  /** See {@link #contextPrefix}. */
  public CompletableFuture<ContextPrefix> contextPrefixAsync(String project) {
    return as(
        "context-prefix",
        transport.call(
            "context-prefix",
            "GET",
            "/v1/context-prefix",
            null,
            Collections.singletonMap("project", project),
            true),
        ContextPrefix.class,
        false);
  }

  /** Store totals. */
  public Stats stats() {
    return await(statsAsync());
  }

  /** See {@link #stats}. */
  public CompletableFuture<Stats> statsAsync() {
    return as(
        "stats", transport.call("stats", "GET", "/v1/stats", null, null, true), Stats.class, false);
  }

  /**
   * Whether the server is healthy. A served {@code {"ok": false}} — including /health's own 503 —
   * is an answer ("not healthy"), not an outage.
   */
  public boolean health() {
    return await(healthAsync());
  }

  /** See {@link #health}. */
  public CompletableFuture<Boolean> healthAsync() {
    return then(
        transport.call("health", "GET", "/health", null, null, true),
        (node, e) -> {
          if (e instanceof NovamemException ne && ne.statusCode() == 503) {
            return false;
          }
          if (e != null) {
            throw rethrow(e);
          }
          return node.path("ok").isBoolean() && node.get("ok").asBoolean();
        });
  }
}
