#!/bin/sh
# Syntax-checks the README's Quickstart (the first ```ruby block), so the
# example a reader copies is at least valid Ruby.
#
# proved by: putting a syntax error in the Quickstart fails this script.
set -eu
cd "$(dirname "$0")"

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT INT TERM

awk '
	/^```ruby[[:space:]]*$/ && !seen { inside = 1; seen = 1; next }
	inside && /^```/ { exit }
	inside { print }
' README.md >"$dir/quickstart.rb"

if [ ! -s "$dir/quickstart.rb" ]; then
	echo "readme ruby: no \`\`\`ruby block in README.md" >&2
	exit 1
fi

ruby -c "$dir/quickstart.rb" >/dev/null
echo "readme ruby: quickstart ok"
