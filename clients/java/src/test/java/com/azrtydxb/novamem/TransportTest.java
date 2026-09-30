package com.azrtydxb.novamem;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** Transport behaviour the shared scenarios cannot reach. */
class TransportTest {
  private HttpServer server;

  @AfterEach
  void stop() {
    if (server != null) {
      server.stop(0);
    }
  }

  private String serve(String path, com.sun.net.httpserver.HttpHandler h) throws Exception {
    server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext(path, h);
    server.start();
    return "http://127.0.0.1:" + server.getAddress().getPort();
  }

  // proved by: dropping the deadline in Transport.call fails this test
  // (HttpRequest.timeout stops at the headers, so the call hangs on the body).
  @Test
  void aBodyThatStallsAfterTheHeadersStillTimesOut() throws Exception {
    String base =
        serve(
            "/v1/stats",
            ex -> {
              ex.sendResponseHeaders(200, 100);
              OutputStream out = ex.getResponseBody();
              out.write("{\"totalWarm\"".getBytes(StandardCharsets.UTF_8));
              out.flush();
              try {
                Thread.sleep(2_000);
              } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
              }
              ex.close();
            });
    Client c =
        new Client(
            NovamemConfig.builder()
                .baseUrl(base)
                .token("nm_t")
                .timeout(Duration.ofMillis(300))
                .build());
    long start = System.nanoTime();
    NovamemException e = assertThrows(NovamemException.class, c::stats);
    assertTrue(e.isUnavailable() && e.isRetryable(), e.toString());
    assertTrue(e.getMessage().contains("timed out"), e.getMessage());
    assertTrue(Duration.ofNanos(System.nanoTime() - start).toMillis() < 3_000, "took too long");
  }

  // proved by: removing src.cancel(true) from Base.then fails this test.
  @Test
  void cancellingAMappedCallCancelsItsSource() {
    CompletableFuture<String> src = new CompletableFuture<>();
    CompletableFuture<Integer> out = Base.then(src, (s, e) -> s.length());
    out.cancel(true);
    assertTrue(src.isCancelled(), "the exchange behind a cancelled call kept running");
  }

  // proved by: resolving a "//host/path" Location against the base path
  // instead of URI.resolve fails this test.
  @Test
  void aNetworkPathRedirectIsAnotherOrigin() throws Exception {
    AtomicReference<String> seen = new AtomicReference<>("not called");
    HttpServer target = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    target.createContext(
        "/moved",
        ex -> {
          String auth = ex.getRequestHeaders().getFirst("Authorization");
          seen.set(auth == null ? "none" : auth);
          byte[] body = "{\"ok\":true}".getBytes(StandardCharsets.UTF_8);
          ex.sendResponseHeaders(200, body.length);
          ex.getResponseBody().write(body);
          ex.close();
        });
    target.start();
    try {
      int port = target.getAddress().getPort();
      String base =
          serve(
              "/health",
              ex -> {
                ex.getResponseHeaders().set("Location", "//localhost:" + port + "/moved");
                ex.sendResponseHeaders(302, -1);
                ex.close();
              });
      assertTrue(new Client(NovamemConfig.builder().baseUrl(base).token("nm_t").build()).health());
      assertEquals("none", seen.get());
    } finally {
      target.stop(0);
    }
  }

  @Test
  void sameOriginComparesSchemeHostAndPort() {
    assertTrue(
        Transport.sameOrigin(
            URI.create("http://a.example/x"), URI.create("HTTP://A.example:80/y")));
    assertTrue(
        !Transport.sameOrigin(URI.create("http://a.example/x"), URI.create("https://a.example/x")));
    assertTrue(
        !Transport.sameOrigin(
            URI.create("http://127.0.0.1:1/x"), URI.create("http://localhost:1/x")));
  }
}
