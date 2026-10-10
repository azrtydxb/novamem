package com.azrtydxb.novamem;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.function.BiFunction;

/**
 * Shared by Client, Management and Admin: the transport, and the local checks that stop a malformed
 * call before it leaves the process. Safe to share across threads.
 */
public abstract class Base {
  final Transport transport;

  Base(NovamemConfig config) {
    if (config == null) {
      throw new IllegalArgumentException("novamem: config is required");
    }
    this.transport = new Transport(config);
  }

  @Override
  public String toString() {
    return getClass().getSimpleName()
        + "[baseUrl="
        + transport.config().redactedBaseUrl()
        + ", token=[redacted]]";
  }

  static boolean blank(String s) {
    return s == null || s.isBlank();
  }

  static String seg(String s) {
    return Transport.encode(s);
  }

  /** An object of the given key/value pairs, leaving out null and empty-string values. */
  static Map<String, Object> fields(Object... kv) {
    Map<String, Object> o = new LinkedHashMap<>();
    for (int i = 0; i < kv.length; i += 2) {
      Object v = kv[i + 1];
      if (v != null && !"".equals(v)) {
        o.put((String) kv[i], v);
      }
    }
    return o;
  }

  static <T> CompletableFuture<T> invalid(String op, String detail) {
    return CompletableFuture.failedFuture(new NovamemException(op, detail));
  }

  /**
   * Maps a call's outcome. Unlike {@code handle}, cancelling the returned future cancels {@code
   * src}, and through it the exchange in flight. {@code fn} gets the unwrapped failure (null on
   * success) and may throw.
   */
  static <T, R> CompletableFuture<R> then(
      CompletableFuture<T> src, BiFunction<T, Throwable, R> fn) {
    CompletableFuture<R> out =
        src.handle(
            (r, e) -> {
              Throwable cause = e == null ? null : Transport.unwrap(e);
              if (cause instanceof CancellationException c) {
                throw c;
              }
              return fn.apply(r, cause);
            });
    out.whenComplete(
        (r, e) -> {
          if (out.isCancelled()) {
            src.cancel(true);
          }
        });
    return out;
  }

  /** Decodes a successful call into {@code cls}; a failure is rethrown as it came. */
  static <R> CompletableFuture<R> as(
      String op, CompletableFuture<JsonNode> src, Class<R> cls, boolean degradedCheck) {
    return then(
        src,
        (node, e) -> {
          if (e != null) {
            throw rethrow(e);
          }
          if (degradedCheck) {
            degradedEmpty(op, node);
          }
          return decode(op, node, cls);
        });
  }

  static <R> R decode(String op, JsonNode node, Class<R> cls) {
    try {
      return Json.MAPPER.treeToValue(node, cls);
    } catch (Exception e) {
      // Valid JSON of the wrong shape: the store did not answer as the API promises.
      throw NovamemException.unavailable(op, "malformed response body", 200, false);
    }
  }

  static RuntimeException rethrow(Throwable e) {
    if (e instanceof RuntimeException r) {
      return r;
    }
    if (e instanceof Error err) {
      throw err;
    }
    return new IllegalStateException(e);
  }

  /**
   * A degraded answer with no results is an outage wearing the costume of an empty result set. A
   * degraded answer WITH results is real data.
   */
  private static void degradedEmpty(String op, JsonNode body) {
    boolean degraded = body.path("degraded").asBoolean(false);
    JsonNode results = body.path("results");
    if (degraded && (!results.isArray() || results.isEmpty())) {
      throw NovamemException.unavailable(
          op,
          "store answered degraded with no results, so this is not evidence of absence",
          200,
          true);
    }
  }

  /**
   * Waits for an async call: its NovamemException (or CancellationException) is thrown as is.
   * Interrupting the waiting thread cancels the call.
   */
  static <T> T await(CompletableFuture<T> f) {
    try {
      return f.get();
    } catch (ExecutionException e) {
      throw rethrow(Transport.unwrap(e));
    } catch (InterruptedException e) {
      f.cancel(true);
      Thread.currentThread().interrupt();
      throw new CancellationException("interrupted");
    }
  }
}
