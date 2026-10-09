# SDK T10: Java SDK

Status: closed 2026-09-25
Created: 2026-09-25

## Description

Ship clients/java (Maven `com.azrtydxb:novamem` 0.1.0, Jackson only, sync plus CompletableFuture), held to the shared scenario suite (plan Task 10, spec S-7).

## Acceptance criteria

- [x] `cd clients/java && mvn -B verify` passes on Java 17 and 21
- [x] Removing the forget 404 handling fails `forget-404-not-deleted` (mutation check, reverted)
- [x] `mvn dependency:tree -Dscope=runtime` lists only jackson-databind, jackson-core and jackson-annotations
- [x] Smoke.java exists, and the `java` job is in sdk.yml

## Evidence

- Local (Maven 3.9.16, installed for this task): `mvn -B verify` on JDK 17 and on JDK 26 → `Tests run: 88, Failures: 0, Errors: 0` (83 scenarios, RouteTest, 4 TransportTest); after the #317 review fixes, 91 with ConfigTest.
- CI: run 36118737378 on #317, jobs `java (17)` and `java (21)` success (maven:3.9-eclipse-temurin images), including the dependency-tree and smoke-program steps.
- Mutations, each reverted: forget 404 rule → `forget-404-not-deleted: expected: <ok> but was: <not_found>`; degraded rule → search-degraded-empty-is-unavailable; redaction → both token-echoed scenarios; cross-origin guard → redirect-cross-origin-drops-bearer; streamed size limit → capture-oversize; the call's own deadline → TransportTest.aBodyThatStallsAfterTheHeadersStillTimesOut; cancel propagation → cancellingAMappedCallCancelsItsSource; network-path resolution → aNetworkPathRedirectIsAnotherOrigin; the ConfigTest pair (URL redaction, query/fragment rejection).
- Runtime tree: jackson-databind 2.22.3 → jackson-annotations 2.22, jackson-core 2.22.3 (2.20.0 had known CVEs; the gate blocked it).
- clients/gen gained `fmt:` (a template may name google-java-format, from a closed list) because gjf lays lines out by length; the `generated` job installs gjf 1.36.1, and `-check` passes.
