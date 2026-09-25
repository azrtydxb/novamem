#!/bin/sh
# Parses the README's Quickstart (the first ```swift block), so the example
# a reader copies is at least valid Swift. `swiftc -parse` checks syntax
# only: it does not resolve the Novamem module.
#
# proved by: putting a syntax error in the Quickstart fails this script.
set -eu
cd "$(dirname "$0")"

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT INT TERM

awk '
	/^```swift[[:space:]]*$/ && !seen { inside = 1; seen = 1; next }
	inside && /^```/ { exit }
	inside { print }
' README.md >"$dir/main.swift"

if [ ! -s "$dir/main.swift" ]; then
	echo "readme swift: no \`\`\`swift block in README.md" >&2
	exit 1
fi

swiftc -parse "$dir/main.swift"
echo "readme swift: quickstart ok"
