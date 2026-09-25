#!/bin/sh
# Every routes.json method has its C function in novamem.h and its C++
# method in novamem.hpp. Both headers are generated from routes.json, so
# this fails only if generation is stale — which `clients/gen -check` also
# catches; this keeps the C job self-contained.
# proved by: deleting any novamem_<class>_<method> declaration fails this script.
set -eu
cd "$(dirname "$0")/.."
python3 - <<'PY'
import json, re, sys
routes = json.load(open("../contract/routes.json"))
h = open("include/novamem.h").read()
hpp = open("include/novamem.hpp").read()
snake = lambda s: re.sub(r"(?<!^)([A-Z])", r"_\1", s).lower()
missing = []
for r in routes.values():
    for m in r.get("methods", []):
        cls, meth = m["name"].split(".")
        if f"novamem_{snake(cls)}_{snake(meth)}(" not in h:
            missing.append(f"novamem.h: {m['name']}")
        # C++ keywords take a trailing underscore (export -> export_).
        if f" {snake(meth)}(" not in hpp and f" {snake(meth)}_(" not in hpp:
            missing.append(f"novamem.hpp: {m['name']}")
print("\n".join(missing) or "routes: every method declared in novamem.h and novamem.hpp")
sys.exit(1 if missing else 0)
PY
