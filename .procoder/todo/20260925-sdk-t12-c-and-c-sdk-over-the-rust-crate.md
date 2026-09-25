# SDK T12: C and C++ SDK over the Rust crate

Status: open
Created: 2026-09-25

## Description

Ship clients/c: a C ABI generated over the Rust crate, cbindgen headers, a header-only C++17 wrapper, and a vcpkg port and Conan recipe (plan Task 12, spec S-9).

## Acceptance criteria

- [ ] `make -C clients/c test` passes both the C11 and the C++17 scenario runners, plus routes.sh
- [ ] `make -C clients/c memcheck` exits 0 under valgrind
- [ ] Making `novamem_forget_result_free` a no-op makes memcheck fail (mutation check, reverted)
- [ ] smoke.c, the vcpkg port and the Conan recipe exist, and the `c` job is in sdk.yml

## Evidence
