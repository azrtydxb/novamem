# C and C++ SDK (ADR 0009): a C ABI over the Rust crate in ../rust.
#
#   make lib       release static library (with the test entry point)
#   make test      C11 and C++17 scenario runners + route check
#   make memcheck  the C runner under valgrind (Linux)
#   make smoke     build the live smoke program

ROOT     := $(abspath ../..)
LIB      := $(ROOT)/target/release/libnovamem_ffi.a
BUILD    := build
UNAME    := $(shell uname)
ifeq ($(UNAME),Darwin)
NATIVE   := -liconv -lSystem -lc -lm
else
NATIVE   := -lpthread -ldl -lm -lgcc_s -lc
endif
CFLAGS   := -std=c11 -Wall -Wextra -Werror -Iinclude
CXXFLAGS := -std=c++17 -Wall -Wextra -Werror -Iinclude

.PHONY: lib test memcheck smoke clean

lib:
	cargo build --release --locked -p novamem-ffi --features test-dispatch

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/scenarios_c: tests/scenarios.c include/novamem.h lib | $(BUILD)
	$(CC) $(CFLAGS) -DNOVAMEM_TEST_DISPATCH tests/scenarios.c $(LIB) $(NATIVE) -o $@

$(BUILD)/scenarios_cpp: tests/scenarios.cpp include/novamem.hpp include/novamem.h lib | $(BUILD)
	$(CXX) $(CXXFLAGS) -DNOVAMEM_TEST_DISPATCH tests/scenarios.cpp $(LIB) $(NATIVE) -o $@

$(BUILD)/null_out: tests/null_out.c include/novamem.h lib | $(BUILD)
	$(CC) $(CFLAGS) tests/null_out.c $(LIB) $(NATIVE) -o $@

test: $(BUILD)/scenarios_c $(BUILD)/scenarios_cpp $(BUILD)/null_out
	$(CXX) $(CXXFLAGS) -fsyntax-only tests/literals.cpp
	$(BUILD)/null_out
	python3 tests/run_scenarios.py $(BUILD)/scenarios_c
	python3 tests/run_scenarios.py $(BUILD)/scenarios_cpp
	sh tests/routes.sh

memcheck: $(BUILD)/scenarios_c
	NOVAMEM_WRAP="valgrind --quiet --error-exitcode=99 --leak-check=full --errors-for-leak-kinds=definite --suppressions=tests/valgrind.supp" \
		python3 tests/run_scenarios.py $(BUILD)/scenarios_c

$(BUILD)/smoke: smoke.c include/novamem.h lib | $(BUILD)
	$(CC) $(CFLAGS) smoke.c $(LIB) $(NATIVE) -o $@

smoke: $(BUILD)/smoke

clean:
	rm -rf $(BUILD)
