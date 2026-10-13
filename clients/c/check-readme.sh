#!/bin/sh
# Compiles the README's Quickstart (the first ```c block) as C11 and its C++
# example (the first ```cpp block) as C++17, against include/, with the
# warnings the SDK's own build treats as errors.
#
# proved by: misspelling a function in the Quickstart fails this script.
set -eu
cd "$(dirname "$0")"

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT INT TERM

# extract <fence tag> <output file>
extract() {
	awk -v tag="$1" '
		$0 ~ "^```" tag "[[:space:]]*$" && !seen { inside = 1; seen = 1; next }
		inside && /^```/ { exit }
		inside { print }
	' README.md >"$2"
	if [ ! -s "$2" ]; then
		echo "readme c: no \`\`\`$1 block in README.md" >&2
		exit 1
	fi
}

extract c "$dir/quickstart.c"
extract cpp "$dir/quickstart.cpp"

cc -std=c11 -Wall -Wextra -Werror -fsyntax-only -Iinclude "$dir/quickstart.c"
c++ -std=c++17 -Wall -Wextra -Werror -fsyntax-only -Iinclude "$dir/quickstart.cpp"
echo "readme c: quickstart ok"
