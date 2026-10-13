#!/bin/sh
# Compiles the README's Quickstart (the first ```python block), so the
# example a reader copies is at least valid Python.
#
# proved by: putting a syntax error in the Quickstart fails this script.
set -eu
cd "$(dirname "$0")"

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT INT TERM

awk '
	/^```python[[:space:]]*$/ && !seen { inside = 1; seen = 1; next }
	inside && /^```/ { exit }
	inside { print }
' README.md >"$dir/quickstart.py"

if [ ! -s "$dir/quickstart.py" ]; then
	echo "readme python: no \`\`\`python block in README.md" >&2
	exit 1
fi

python3 -m py_compile "$dir/quickstart.py"
echo "readme python: quickstart ok"
