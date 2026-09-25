package com.azrtydxb.novamem;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Locale;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletionException;
import java.util.stream.Stream;
import java.util.stream.StreamSupport;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

/** The shared behaviour suite (clients/contract/scenarios.json, ADR 0009). */
class ScenarioTest {
  static final Path CONTRACT = Path.of("..", "contract").toAbsolutePath().normalize();
  static JsonNode scen;
  static Process proc;
  static String url;
  static String closed;

  @BeforeAll
  static void start() throws Exception {
    scen = Json.MAPPER.readTree(CONTRACT.resolve("scenarios.json").toFile());
    proc =
        new ProcessBuilder("sh", "scenario-server.sh", "-scenarios", "scenarios.json")
            .directory(CONTRACT.toFile())
            .redirectError(ProcessBuilder.Redirect.INHERIT)
            .start();
    String[] parts =
        new BufferedReader(new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))
            .readLine()
            .split(" ");
    url = parts[1];
    closed = parts[2].split("=")[1];
  }

  @AfterAll
  static void stop() {
    proc.destroyForcibly();
  }

  static Stream<String> ids() throws Exception {
    JsonNode s = Json.MAPPER.readTree(CONTRACT.resolve("scenarios.json").toFile()).get("scenarios");
    return StreamSupport.stream(s.spliterator(), false).map(x -> x.get("id").asText());
  }

  static boolean isEmpty(Object r) {
    JsonNode n = Json.MAPPER.valueToTree(r);
    return (n.isArray() && n.isEmpty())
        || (n.isObject() && n.has("results") && n.get("results").isEmpty());
  }

  /** "" when every field of want is in got with the same value; else where they differ. */
  static String subset(JsonNode want, JsonNode got, String path) {
    if (want.isObject()) {
      if (got == null || !got.isObject()) {
        return path + ": want an object, got " + got;
      }
      for (var e : want.properties()) {
        String d = subset(e.getValue(), got.get(e.getKey()), path + "." + e.getKey());
        if (!d.isEmpty()) {
          return d;
        }
      }
      return "";
    }
    if (want.isNumber() && got != null && got.isNumber()) {
      return want.doubleValue() == got.doubleValue()
          ? ""
          : path + ": got " + got + ", want " + want;
    }
    return want.equals(got) ? "" : path + ": got " + got + ", want " + want;
  }

  // proved by: removing the degraded-empty check from Client.searchAsync fails
  // search-degraded-empty-is-unavailable; removing the redaction in Transport
  // fails token-echoed-in-401-is-redacted.
  @ParameterizedTest
  @MethodSource("ids")
  void testScenarios(String id) throws Exception {
    JsonNode s = null;
    for (JsonNode x : scen.get("scenarios")) {
      if (x.get("id").asText().equals(id)) {
        s = x;
      }
    }
    JsonNode call = s.get("call");
    String token = scen.get("token").asText();
    Object result = null;
    Throwable err = null;
    if (call.get("class").asText().equals("ctor")) {
      JsonNode a = call.get("args");
      try {
        new Client(
            NovamemConfig.builder()
                .baseUrl(a.get("baseUrl").asText().replace("<server>", url))
                .token(a.get("token").asText())
                .build());
      } catch (Exception e) {
        err = e;
      }
    } else {
      String base =
          s.path("respond").toString().contains("\"refused\"")
              ? "http://127.0.0.1:" + closed + "/s/" + id
              : url + "/s/" + id;
      NovamemConfig cfg =
          NovamemConfig.builder()
              .baseUrl(base)
              .token(token)
              .timeout(Duration.ofMillis(scen.get("timeoutMs").asLong()))
              .build();
      Dispatch.Clients c =
          new Dispatch.Clients(new Client(cfg), new Management(cfg), new Admin(cfg));
      boolean cancel = call.has("cancelAfterMs");
      try {
        result =
            Dispatch.TABLE
                .get(call.get("method").asText())
                .call(c, call.get("args"), cancel, cancel ? call.get("cancelAfterMs").asLong() : 0);
      } catch (CompletionException e) {
        err = e.getCause();
      } catch (Exception e) {
        err = e;
      }
    }
    String outcome =
        err == null
            ? (isEmpty(result) ? "empty" : "ok")
            : err instanceof CancellationException
                ? "canceled"
                : err instanceof NovamemException ne && ne.isUnavailable()
                    ? "unavailable"
                    : err instanceof NovamemException ne2 && ne2.isNotFound()
                        ? "not_found"
                        : "error";
    JsonNode exp = s.get("expect");
    assertEquals(exp.get("outcome").asText(), outcome, id + ": " + err);
    if (err != null) {
      assertFalse(String.valueOf(err).contains(token), id + ": token leaked");
      if (err instanceof NovamemException ne) {
        if (exp.has("retryable")) {
          assertEquals(exp.get("retryable").asBoolean(), ne.isRetryable(), id + ": retryable");
        }
        if (exp.has("statusCode")) {
          assertEquals(exp.get("statusCode").asInt(), ne.statusCode(), id + ": status");
        }
        if (exp.has("code")) {
          assertEquals(exp.get("code").asText(), ne.code(), id + ": code");
        }
      }
      if (exp.has("messageContains")) {
        String want = exp.get("messageContains").asText().toLowerCase(Locale.ROOT);
        assertTrue(
            String.valueOf(err.getMessage()).toLowerCase(Locale.ROOT).contains(want),
            id + ": message " + err.getMessage());
      }
    }
    if (exp.has("result")) {
      String d = subset(exp.get("result"), Json.MAPPER.valueToTree(result), "$");
      assertEquals("", d, id + ": result");
    }
    if (!call.get("class").asText().equals("ctor")) {
      HttpResponse<String> v =
          HttpClient.newHttpClient()
              .send(
                  HttpRequest.newBuilder(URI.create(url + "/_verdict/" + id)).build(),
                  HttpResponse.BodyHandlers.ofString());
      JsonNode verdict = Json.MAPPER.readTree(v.body());
      assertEquals(0, verdict.get("mismatches").size(), id + ": " + verdict);
      if (s.path("expectRequest").isArray() && s.get("expectRequest").isEmpty()) {
        assertEquals(0, verdict.get("requests").asInt(), id + ": expected no request");
      }
    }
  }
}
