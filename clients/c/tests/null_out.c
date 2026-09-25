/* A NULL out-pointer is rejected before the call, so no result is
 * allocated with nowhere to go (which would leak).
 * proved by: removing the out.is_null() check in rust_ffi_methods.tmpl makes
 * this return NOVAMEM_OK. */
#include <stdio.h>
#include <string.h>

#include "novamem.h"

int main(void) {
    novamem_error err = {0};
    /* Port 1: if the call were made it would fail differently (unreachable). */
    novamem_client *c = novamem_client_new("http://127.0.0.1:1", "nm_x", 0, &err);
    if (!c) {
        printf("FAIL: client: %s\n", err.message);
        return 1;
    }
    novamem_status st = novamem_client_stats(c, NULL, &err);
    novamem_client_free(c);
    if (st != NOVAMEM_ERR || strstr(err.message, "out must not be NULL") == NULL || err.unavailable) {
        printf("FAIL: status %d, message %s\n", (int)st, err.message);
        return 1;
    }
    printf("null out rejected: %s\n", err.message);
    return 0;
}
