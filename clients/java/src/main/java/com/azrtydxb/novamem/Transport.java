package com.azrtydxb.novamem;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.StringJoiner;
import java.util.TreeMap;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** One method makes every request, so failures are classified once. */
final class Transport {
  /** Responses larger than this are rejected rather than buffered. */
  static final int MAX_RESPONSE_BYTES = 8 << 20;

  private static final int MAX_REDIRECTS = 5;

  private final NovamemConfig cfg;
  private final HttpClient http;

  Transport(NovamemConfig cfg) {
    this.cfg = cfg;
    this.http =
        cfg.httpClient() != null
            ? cfg.httpClient()
            : HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(cfg.timeout())
                .build();
  }

  NovamemConfig config() {
    return cfg;
  }

  String redact(String s) {
    return s == null ? "" : s.replace(cfg.token(), "[redacted]");
  }

  /**
   * Performs one request. The future yields the decoded JSON object (null when {@code expectBody}
   * is false) or fails with a NovamemException. Cancelling it cancels the exchange in flight.
   */
  CompletableFuture<JsonNode> call(
      String op,
      String method,
      String path,
      Object body,
      Map<String, ?> query,
      boolean expectBody) {
    byte[] payload;
    try {
      payload = body == null ? null : Json.MAPPER.writeValueAsBytes(body);
    } catch (JsonProcessingException e) {
      return CompletableFuture.failedFuture(
          // The message can quote request values, and a revoke body holds a token.
          new NovamemException(op, redact("encode request: " + e.getOriginalMessage())));
    }
    URI url = URI.create(cfg.baseUrl() + path + query(query));

    CompletableFuture<JsonNode> result = new CompletableFuture<>();
    AtomicReference<CompletableFuture<?>> inflight = new AtomicReference<>();
    // Every call is bounded, redirects and body included. The deadline, the
    // caller's cancel and completion race; whichever ends the result first
    // wins, and the exchange in flight is cancelled with it.
    result.whenComplete(
        (r, e) -> {
          CompletableFuture<?> f = inflight.get();
          if (f != null) {
            f.cancel(true);
          }
        });
    CompletableFuture.delayedExecutor(cfg.timeout().toMillis(), TimeUnit.MILLISECONDS)
        .execute(() -> result.completeExceptionally(timedOut(op)));
    hop(op, method, url, payload, true, 0, expectBody, result, inflight);
    return result;
  }

  /**
   * One request of a call. Redirects are followed here, up to 5, so the bearer never reaches
   * another origin (Go's http.Client drops it on a cross-origin hop; so does this). 303, and
   * 301/302 after a POST, continue as a bodyless GET.
   */
  private void hop(
      String op,
      String method,
      URI url,
      byte[] payload,
      boolean auth,
      int hops,
      boolean expectBody,
      CompletableFuture<JsonNode> result,
      AtomicReference<CompletableFuture<?>> inflight) {
    HttpRequest.Builder req =
        HttpRequest.newBuilder(url)
            .timeout(cfg.timeout())
            .header("Accept", "application/json")
            .method(
                method,
                payload == null
                    ? HttpRequest.BodyPublishers.noBody()
                    : HttpRequest.BodyPublishers.ofByteArray(payload));
    if (auth) {
      req.header("Authorization", "Bearer " + cfg.token());
    }
    if (payload != null) {
      req.header("Content-Type", "application/json");
    }
    CompletableFuture<HttpResponse<byte[]>> f = http.sendAsync(req.build(), Transport::limited);
    inflight.set(f);
    if (result.isDone()) {
      f.cancel(true);
      return;
    }
    f.whenComplete(
        (resp, err) -> {
          if (result.isDone()) {
            return;
          }
          if (err != null) {
            result.completeExceptionally(transportError(op, unwrap(err)));
            return;
          }
          int status = resp.statusCode();
          var location = resp.headers().firstValue("Location");
          if (status >= 300 && status < 400 && status != 304 && location.isPresent()) {
            if (hops >= MAX_REDIRECTS) {
              result.completeExceptionally(
                  NovamemException.unavailable(op, "too many redirects", status, false));
              return;
            }
            URI next;
            try {
              next = url.resolve(location.get());
            } catch (IllegalArgumentException e) {
              result.completeExceptionally(
                  NovamemException.unavailable(op, "bad redirect location", status, false));
              return;
            }
            boolean post = "POST".equals(method);
            boolean toGet = status == 303 || ((status == 301 || status == 302) && post);
            hop(
                op,
                toGet ? "GET" : method,
                next,
                toGet ? null : payload,
                auth && sameOrigin(url, next),
                hops + 1,
                expectBody,
                result,
                inflight);
            return;
          }
          try {
            result.complete(decode(op, status, resp.body(), expectBody));
          } catch (NovamemException e) {
            result.completeExceptionally(e);
          }
        });
  }

  static boolean sameOrigin(URI a, URI b) {
    return a.getScheme().equalsIgnoreCase(String.valueOf(b.getScheme()))
        && String.valueOf(a.getHost()).equalsIgnoreCase(String.valueOf(b.getHost()))
        && port(a) == port(b);
  }

  private static int port(URI u) {
    return u.getPort() != -1 ? u.getPort() : "https".equalsIgnoreCase(u.getScheme()) ? 443 : 80;
  }

  private static String query(Map<String, ?> q) {
    if (q == null) {
      return "";
    }
    StringJoiner out = new StringJoiner("&", "?", "");
    out.setEmptyValue("");
    for (var e : new TreeMap<>(q).entrySet()) {
      String v = e.getValue() == null ? "" : String.valueOf(e.getValue());
      if (!v.isEmpty()) {
        out.add(encode(e.getKey()) + "=" + encode(v));
      }
    }
    return out.toString();
  }

  /** Percent-encodes a query value or path segment (a space is %20, not +). */
  static String encode(String s) {
    return URLEncoder.encode(s, StandardCharsets.UTF_8).replace("+", "%20");
  }

  private NovamemException timedOut(String op) {
    return NovamemException.unavailable(op, "timed out", 0, true);
  }

  private RuntimeException transportError(String op, Throwable e) {
    if (e instanceof CancellationException c) {
      return c;
    }
    if (e instanceof Oversize o) {
      return NovamemException.unavailable(op, "response body exceeds 8 MiB", o.status, false);
    }
    if (e instanceof HttpTimeoutException) {
      return timedOut(op);
    }
    // Refused dial, DNS, reset, TLS: the host could not be consulted.
    String why = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
    return NovamemException.unavailable(op, redact("unreachable: " + why), 0, true);
  }

  static Throwable unwrap(Throwable e) {
    while ((e instanceof CompletionException || e instanceof ExecutionException)
        && e.getCause() != null) {
      e = e.getCause();
    }
    return e;
  }

  private JsonNode decode(String op, int status, byte[] raw, boolean expectBody) {
    if (status < 200 || status >= 300) {
      throw httpError(op, status, raw);
    }
    if (!expectBody) {
      return null;
    }
    String text = new String(raw, StandardCharsets.UTF_8);
    // A 2xx with no body is not the contract: decoding it into a default
    // would tell a forget caller the delete happened.
    if (text.isBlank()) {
      throw NovamemException.unavailable(op, "empty response body", status, false);
    }
    JsonNode node;
    try {
      node = Json.MAPPER.readTree(raw);
    } catch (IOException e) {
      node = null;
    }
    // Every success body is a JSON object. Anything else — in practice a
    // proxy's HTML error page — means we never reached a working novamem.
    // Not retryable: the same request parses the same way.
    if (node == null || !node.isObject()) {
      throw NovamemException.unavailable(op, "malformed response body", status, false);
    }
    return node;
  }

  private NovamemException httpError(String op, int status, byte[] raw) {
    String message = "";
    String code = "";
    try {
      JsonNode n = Json.MAPPER.readTree(raw);
      if (n != null && n.path("error").isTextual() && !n.get("error").asText().isEmpty()) {
        message = n.get("error").asText();
        code = n.path("code").isTextual() ? n.get("code").asText() : "";
      }
    } catch (IOException e) {
      // not JSON: fall through to the raw text
    }
    if (message.isEmpty()) {
      String text = new String(raw, StandardCharsets.UTF_8).strip();
      message =
          text.codePointCount(0, text.length()) > 256
              ? text.substring(0, text.offsetByCodePoints(0, 256)) + "…"
              : text;
    }
    // The server's message and code are quoted verbatim; a server echoing
    // the credential back would otherwise launder it into the logs.
    boolean unavailable = status >= 500 || status == 429;
    return new NovamemException(
        op, redact(message), status, redact(code), unavailable, unavailable);
  }

  /** The body, streamed and cut off once it crosses the limit instead of buffered whole. */
  private static HttpResponse.BodySubscriber<byte[]> limited(HttpResponse.ResponseInfo info) {
    return new Limited(info.statusCode());
  }

  /** A response body over {@link #MAX_RESPONSE_BYTES}. */
  static final class Oversize extends IOException {
    private static final long serialVersionUID = 1L;
    final int status;

    Oversize(int status) {
      super("response body exceeds 8 MiB");
      this.status = status;
    }
  }

  private static final class Limited implements HttpResponse.BodySubscriber<byte[]> {
    private final int status;
    private final CompletableFuture<byte[]> body = new CompletableFuture<>();
    private final ByteArrayOutputStream buf = new ByteArrayOutputStream();
    private Flow.Subscription sub;

    Limited(int status) {
      this.status = status;
    }

    @Override
    public CompletionStage<byte[]> getBody() {
      return body;
    }

    @Override
    public void onSubscribe(Flow.Subscription s) {
      sub = s;
      s.request(Long.MAX_VALUE);
    }

    @Override
    public void onNext(List<ByteBuffer> items) {
      if (body.isDone()) {
        return;
      }
      for (ByteBuffer b : items) {
        if (buf.size() + b.remaining() > MAX_RESPONSE_BYTES) {
          sub.cancel();
          body.completeExceptionally(new Oversize(status));
          return;
        }
        byte[] chunk = new byte[b.remaining()];
        b.get(chunk);
        buf.write(chunk, 0, chunk.length);
      }
    }

    @Override
    public void onError(Throwable t) {
      body.completeExceptionally(t);
    }

    @Override
    public void onComplete() {
      body.complete(buf.toByteArray());
    }
  }
}
