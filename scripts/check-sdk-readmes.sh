#!/bin/sh
# Keeps the nine SDK READMEs honest:
#
#   sh scripts/check-sdk-readmes.sh tables   every README's Operations table has a
#                                            row for each of the 41 routes.json methods
#   sh scripts/check-sdk-readmes.sh <lang>   that SDK's Quickstart compiles
#                                            (clients/<lang>/check-readme.sh)
#   sh scripts/check-sdk-readmes.sh          both, for every SDK
#
# proved by: deleting a method row from any clients/<lang>/README.md
# operations table fails `tables`.
set -eu
cd "$(dirname "$0")/.."

tables() {
	python3 - <<'EOF'
import json, pathlib, re, sys

routes = json.load(open("clients/contract/routes.json"))
methods = sorted({m["name"] for r in routes.values() for m in r.get("methods", [])})
snake = lambda s: re.sub(r"(?<!^)([A-Z])", r"_\1", s).lower()
camel = lambda s: s[0].lower() + s[1:]
# A keyword gets the name the SDK actually uses.
rename = {"python": {"import": "import_"}, "java": {"import": "importEntries"}}
case = {
    "python": snake, "ruby": snake, "rust": snake,
    "typescript": camel, "java": camel, "swift": camel, "php": camel,
    "dotnet": lambda s: s + "Async",
    "c": None,
}
fail = []
for lang, f in case.items():
    text = pathlib.Path(f"clients/{lang}/README.md").read_text()
    for m in methods:
        cls, meth = m.split(".")
        if lang == "c":
            name = f"novamem_{snake(cls)}_{snake(meth)}"
        else:
            name = f(meth)
            name = rename.get(lang, {}).get(name, name)
        if not re.search(rf"^\|\s*`{re.escape(name)}(?![A-Za-z0-9_])", text, re.M):
            fail.append(f"{lang}: operations table has no row for {name}")
print("\n".join(fail) if fail else f"tables: all {len(methods)} methods in every README")
sys.exit(1 if fail else 0)
EOF
}

quickstart() {
	sh "clients/$1/check-readme.sh" || {
		echo "FAIL $1 quickstart"
		return 1
	}
}

case "${1:-}" in
"")
	tables
	for lang in python typescript dotnet java rust c ruby php swift; do
		quickstart "$lang"
	done
	;;
tables) tables ;;
python | typescript | dotnet | java | rust | c | ruby | php | swift) quickstart "$1" ;;
*)
	echo "usage: check-sdk-readmes.sh [tables|<lang>]" >&2
	exit 2
	;;
esac
