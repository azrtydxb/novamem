#!/bin/sh
# Type-checks the README's Quickstart (the first ```ts block) against this
# package's own declarations, under strict mode, so the example a reader
# copies calls methods and fields that exist with the types they have.
#
# proved by: misspelling a method in the Quickstart fails this script.
set -eu
cd "$(dirname "$0")"
here=$(pwd)

if [ ! -d node_modules ]; then
	npm ci --silent
fi
# Build when dist is missing or older than any source file.
if [ ! -f dist/index.d.ts ] || [ -n "$(find src -newer dist/index.d.ts)" ]; then
	npm run --silent build
fi

dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT INT TERM

awk '
	/^```ts[[:space:]]*$/ && !seen { inside = 1; seen = 1; next }
	inside && /^```/ { exit }
	inside { print }
' README.md >"$dir/block.ts"

if [ ! -s "$dir/block.ts" ]; then
	echo "readme typescript: no \`\`\`ts block in README.md" >&2
	exit 1
fi

# Imports stay at module scope; everything else runs inside main(), so the
# Quickstart may use await as a reader's async function would.
{
	grep '^import ' "$dir/block.ts" || true
	echo 'export async function main(): Promise<void> {'
	grep -v '^import ' "$dir/block.ts" || true
	echo '}'
} >"$dir/main.mts"

cat >"$dir/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"],
    "typeRoots": ["$here/node_modules/@types"],
    "paths": { "@azrtydxb/novamem": ["$here/dist/index.d.ts"] }
  },
  "files": ["main.mts"]
}
JSON

npx tsc --noEmit -p "$dir/tsconfig.json"
echo "readme typescript: quickstart ok"
