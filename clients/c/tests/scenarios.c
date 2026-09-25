/* One scenario call through the C ABI, for tests/run_scenarios.py:
 *
 *   scenarios_c <base_url> <token> <timeout_ms> <method|ctor> <args_json>
 *
 * prints one line — "<outcome> <retryable 0|1> <status> <code|-> <message>" —
 * which the harness compares with the scenario's expectation. JSON parsing
 * stays in the harness, so this runner needs nothing beyond novamem.h. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "novamem.h"

int main(int argc, char **argv) {
    if (argc != 6) {
        fprintf(stderr, "usage: %s base token timeout_ms method args_json\n", argv[0]);
        return 2;
    }
    const char *base = argv[1], *token = argv[2], *method = argv[4], *args = argv[5];
    uint32_t timeout = (uint32_t)strtoul(argv[3], NULL, 10);
    novamem_error err;
    memset(&err, 0, sizeof err);
    char *result = NULL;
    novamem_status st;
    if (strcmp(method, "ctor") == 0) {
        novamem_client *c = novamem_client_new(base, token, timeout, &err);
        st = c ? NOVAMEM_OK : NOVAMEM_ERR;
        novamem_client_free(c);
    } else {
        st = novamem_test_call_by_name(base, token, timeout, method, args, &result, &err);
    }
    if (st == NOVAMEM_OK) {
        int empty = result && (strcmp(result, "[]") == 0 || strstr(result, "\"results\":[]") != NULL);
        printf("%s 0 0 - %s\n", empty ? "empty" : "ok", result ? result : "null");
    } else {
        const char *o = err.unavailable ? "unavailable" : err.not_found ? "not_found" : "error";
        printf("%s %d %d %s %s\n", o, err.retryable ? 1 : 0, err.status_code, err.code[0] ? err.code : "-",
               err.message);
    }
    novamem_string_free(result);
    return 0;
}
