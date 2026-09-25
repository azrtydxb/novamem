# SDK T10: Java SDK

Status: open
Created: 2026-09-25

## Description

Ship clients/java (Maven `com.azrtydxb:novamem` 0.1.0, Jackson only, sync plus CompletableFuture), held to the shared scenario suite (plan Task 10, spec S-7).

## Acceptance criteria

- [ ] `cd clients/java && mvn -B verify` passes on Java 17 and 21
- [ ] Removing the forget 404 handling fails `forget-404-not-deleted` (mutation check, reverted)
- [ ] `mvn dependency:tree -Dscope=runtime` lists only jackson-databind, jackson-core and jackson-annotations
- [ ] Smoke.java exists, and the `java` job is in sdk.yml

## Evidence
