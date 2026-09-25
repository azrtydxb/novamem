/* Live round trip against a real server, for the sdk-smoke CI job, using
 * only the public C API:
 *
 *   NOVAMEM_SMOKE_URL=… NOVAMEM_SMOKE_TOKEN=… build/smoke up|down
 *
 * up:   capture → search finds it → forget deletes it → search no longer finds it.
 * down: the server has been stopped; search must report unavailable, not an
 *       empty result. Every failure prints "c <step>: <detail>" and exits 1. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "novamem.h"

static void fail(const char *step, const char *detail) {
    printf("c %s: %s\n", step, detail);
    exit(1);
}

static void check(const char *step, novamem_status st, const novamem_error *err) {
    if (st != NOVAMEM_OK)
        fail(step, err->message);
}

static int found(const novamem_search_result *r, const char *id) {
    for (size_t i = 0; i < r->results_len; i++) {
        if (r->results[i].id && strcmp(r->results[i].id, id) == 0)
            return 1;
    }
    return 0;
}

static novamem_search_result *search(novamem_client *c, const char *query, const char *step) {
    novamem_error err = {0};
    novamem_search_request req = {0};
    req.query = query;
    req.namespace_ = "sdk-smoke";
    novamem_search_result *out = NULL;
    check(step, novamem_client_search(c, &req, &out, &err), &err);
    return out;
}

int main(int argc, char **argv) {
    const char *mode = argc > 1 ? argv[1] : "up";
    const char *url = getenv("NOVAMEM_SMOKE_URL"), *token = getenv("NOVAMEM_SMOKE_TOKEN");
    novamem_error err = {0};
    novamem_client *c = novamem_client_new(url ? url : "", token ? token : "", 0, &err);
    if (!c)
        fail("connect", err.message);

    if (strcmp(mode, "down") == 0) {
        novamem_search_request req = {0};
        req.query = "anything";
        novamem_search_result *out = NULL;
        novamem_status st = novamem_client_search(c, &req, &out, &err);
        novamem_search_result_free(out);
        novamem_client_free(c);
        if (st == NOVAMEM_OK)
            fail("down", "search succeeded against a stopped server");
        if (!err.unavailable)
            fail("down", err.message);
        printf("PASS c down\n");
        return 0;
    }

    char marker[64], content[128];
    snprintf(marker, sizeof marker, "c%lx%lx", (unsigned long)time(NULL), (unsigned long)clock());
    snprintf(content, sizeof content, "sdk-smoke c %s", marker);

    novamem_capture_request cap_req = {0};
    cap_req.content = content;
    cap_req.namespace_ = "sdk-smoke";
    cap_req.has_force = true;
    cap_req.force = true;
    novamem_capture_result *cap = NULL;
    check("capture", novamem_client_capture(c, &cap_req, &cap, &err), &err);
    if (!cap->id || !cap->id[0])
        fail("capture", "not saved");

    novamem_search_result *hits = search(c, marker, "search");
    if (!found(hits, cap->id))
        fail("search", "captured entry not found");
    novamem_search_result_free(hits);

    novamem_forget_request forget_req = {0};
    forget_req.id = cap->id;
    novamem_forget_result *gone = NULL;
    check("forget", novamem_client_forget(c, &forget_req, &gone, &err), &err);
    if (!gone->deleted)
        fail("forget", "not deleted");
    novamem_forget_result_free(gone);

    novamem_search_result *after = search(c, marker, "search-after-forget");
    if (found(after, cap->id))
        fail("search-after-forget", "entry still returned");
    novamem_search_result_free(after);

    novamem_capture_result_free(cap);
    novamem_client_free(c);
    printf("PASS c up\n");
    return 0;
}
