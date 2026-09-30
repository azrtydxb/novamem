// Live round trip against a real server, for the sdk-smoke CI job.
//
//   mvn -q dependency:build-classpath -Dmdep.outputFile=cp.txt
//   NOVAMEM_SMOKE_URL=… NOVAMEM_SMOKE_TOKEN=… \
//     java -cp "$(cat cp.txt):target/classes:target/test-classes" com.azrtydxb.novamem.Smoke
// up|down
//
// up:   capture → search finds it → forget deletes it → search no longer finds it.
// down: the server has been stopped; search must report unavailable, not an
//       empty result. Every failure prints "java <step>: <detail>" and exits 1.

package com.azrtydxb.novamem;

import com.azrtydxb.novamem.types.Types.CaptureRequest;
import com.azrtydxb.novamem.types.Types.CaptureResult;
import com.azrtydxb.novamem.types.Types.ForgetRequest;
import com.azrtydxb.novamem.types.Types.SearchRequest;
import com.azrtydxb.novamem.types.Types.SearchResult;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;

final class Smoke {
  private Smoke() {}

  private static void fail(String step, String detail) {
    System.out.println("java " + step + ": " + detail);
    System.exit(1);
  }

  private static <T> T step(String name, Supplier<T> f) {
    try {
      return f.get();
    } catch (RuntimeException e) {
      fail(name, e.getMessage());
      throw e;
    }
  }

  public static void main(String[] args) {
    Client c =
        step(
            "connect",
            () ->
                new Client(
                    NovamemConfig.builder()
                        .baseUrl(Objects.toString(System.getenv("NOVAMEM_SMOKE_URL"), ""))
                        .token(Objects.toString(System.getenv("NOVAMEM_SMOKE_TOKEN"), ""))
                        .build()));

    if (args.length > 0 && args[0].equals("down")) {
      try {
        c.search(SearchRequest.builder().query("anything").build());
        fail("down", "search succeeded against a stopped server");
      } catch (NovamemException e) {
        if (!e.isUnavailable()) {
          fail("down", "want unavailable, got " + e.getMessage());
        }
        System.out.println("PASS java down");
        return;
      }
    }

    String marker = UUID.randomUUID().toString().replace("-", "");
    SearchRequest query = SearchRequest.builder().query(marker).namespace("sdk-smoke").build();
    CaptureResult cap =
        step(
            "capture",
            () ->
                c.capture(
                    CaptureRequest.builder()
                        .content("sdk-smoke java " + marker)
                        .namespace("sdk-smoke")
                        .force(true)
                        .build()));
    if (cap.id() == null || cap.id().isEmpty()) {
      fail("capture", "not saved");
    }
    SearchResult hits = step("search", () -> c.search(query));
    if (hits.results().stream().noneMatch(r -> cap.id().equals(r.id()))) {
      fail("search", "captured " + cap.id() + " not found");
    }
    var gone = step("forget", () -> c.forget(ForgetRequest.builder().id(cap.id()).build()));
    if (!Boolean.TRUE.equals(gone.deleted())) {
      fail("forget", "not deleted");
    }
    SearchResult after = step("search-after-forget", () -> c.search(query));
    if (after.results().stream().anyMatch(r -> cap.id().equals(r.id()))) {
      fail("search-after-forget", cap.id() + " still returned");
    }
    System.out.println("PASS java up");
  }
}
