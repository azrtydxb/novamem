# SDK T12: C and C++ SDK over the Rust crate

Status: closed 2026-09-25
Created: 2026-09-25

## Description

Ship clients/c: a C ABI generated over the Rust crate, cbindgen headers, a header-only C++17 wrapper, and a vcpkg port and Conan recipe (plan Task 12, spec S-9).

## Acceptance criteria

- [x] `make -C clients/c test` passes both the C11 and the C++17 scenario runners, plus routes.sh
- [x] `make -C clients/c memcheck` exits 0 under valgrind
- [x] A missing free makes memcheck fail (mutation check, reverted) — run on a leaked result string, since `novamem_forget_result_free` lives in a generated file that the `generated` job would reject before `c` ran
- [x] smoke.c exists and the `c` job is in sdk.yml; the vcpkg port and Conan recipe moved to Task 17 (they need a release's SHA-512) and are in clients/c/port on #319

## Evidence

- CI (valgrind is Linux-only; no local run): PR #312 run 36112944229, job `c` — `build/scenarios_c: 83 scenarios, 0 failure(s)`, `build/scenarios_cpp: 83 scenarios, 0 failure(s)`, routes.sh clean, then `make memcheck` exit 0.
- Mutation: a temporary commit on #312 (fb09649, force-pushed away; the branch is back at 262ce55) removed `novamem_string_free(result)` from tests/scenarios.c. Run 36119013306's memcheck then failed 44 of 81 scenarios with valgrind's error exit (99) — every scenario that returns a result.
- The shared redirect scenarios (#315) exposed one more memcheck report: glibc's resolver configuration, allocated by getaddrinfo on a tokio blocking thread still alive at exit, when redirect-cross-origin-drops-bearer resolves "localhost". It is suppressed narrowly (tests/valgrind.supp: definite leaks from `__resolv_conf_allocate` under `getaddrinfo` only), so every allocation of the C ABI stays checked.
