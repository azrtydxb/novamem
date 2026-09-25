#!/bin/sh
# proved by: changing a release-sdk workflow's tag pattern to "v*" fails this script.
set -eu
cd "$(dirname "$0")/.."
fail=0
for lang in python typescript dotnet java rust c ruby php swift; do
	f=".github/workflows/release-sdk-$lang.yml"
	[ -f "$f" ] || {
		echo "missing $f"
		fail=1
		continue
	}
	pats=$(python3 -c "import sys,yaml;d=yaml.safe_load(open('$f'));print('\n'.join((d.get(True) or d.get('on'))['push']['tags']))")
	[ "$pats" = "clients/$lang/v*" ] || {
		echo "$f: tags = $pats, want clients/$lang/v*"
		fail=1
	}
done
# The server's tag-triggered workflows (release-binaries.yml, and ci.yml,
# which publishes semver image tags) must never fire for an SDK tag.
python3 - <<'EOF' || fail=1
import fnmatch, sys, yaml
bad = []
for f in (".github/workflows/release-binaries.yml", ".github/workflows/ci.yml"):
    d = yaml.safe_load(open(f))
    pats = (d.get(True) or d.get("on"))["push"].get("tags", [])
    for lang in ("python", "typescript", "dotnet", "java", "rust", "c", "ruby", "php", "swift"):
        bad += [f"{f}: {p} matches clients/{lang}/v0.1.0" for p in pats if fnmatch.fnmatchcase(f"clients/{lang}/v0.1.0", p)]
if bad: print("\n".join(bad)); sys.exit(1)
EOF
exit $fail
