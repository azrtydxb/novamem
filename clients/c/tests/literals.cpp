// Compiles only if a C++ caller can build a request from literals, as the
// const request fields promise (-std=c++17 -Werror, syntax only).
// proved by: declaring request string fields as `char *` again fails this build.
#include "novamem.hpp"

void build_requests() {
    novamem_search_request r{};
    r.query = "coffee";
    r.namespace_ = "prefs";
    const char *projects[] = {"p1", "p2"};
    r.include_projects = projects;
    r.include_projects_len = 2;
    novamem_capture_request c{};
    c.content = "User prefers dark roast";
    (void)r;
    (void)c;
}
