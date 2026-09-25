#!/bin/sh
# Compiles the README's Quickstart (the first ```rust block) as an example
# of this crate, so the program a reader copies builds against the real API.
#
# proved by: misspelling a method in the Quickstart fails this script.
set -eu
cd "$(dirname "$0")"

example=examples/readme.rs
trap 'rm -f "$example"' EXIT
trap 'exit 1' INT TERM

awk '
	/^```rust[[:space:]]*$/ && !seen { inside = 1; seen = 1; next }
	inside && /^```/ { exit }
	inside { print }
' README.md >"$example"

if [ ! -s "$example" ]; then
	echo "readme rust: no \`\`\`rust block in README.md" >&2
	exit 1
fi

cargo check --quiet --example readme --manifest-path Cargo.toml
echo "readme rust: quickstart ok"
