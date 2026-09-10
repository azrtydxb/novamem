#!/usr/bin/env bash
# Copy the built admin-ui SPA into the tree so `go:embed` can reach it.
#
# `go:embed` cannot escape the module directory, so the built dist/ is
# mirrored into go/internal/httpapi/admin-ui/ and committed — the same
# arrangement openapi.json already uses. Run this after every admin-ui
# build (the Dockerfile does exactly that):
#
#   pnpm --filter @azrtydxb/novamem-admin-ui build
#   go/scripts/sync-admin-ui.sh
#
# `*.woff` is excluded deliberately: @fontsource emits every face twice,
# woff2 first with woff as the fallback, and no browser since ~2016 asks
# for the woff. Dropping it takes the committed copy from 2.1 MB to
# 1.4 MB with no behavioural change.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/../../packages/admin-ui/dist"
dst="$here/../internal/httpapi/admin-ui"

if [ ! -f "$src/index.html" ]; then
	echo "sync-admin-ui: $src/index.html missing — run the admin-ui build first" >&2
	exit 1
fi

rm -rf "$dst"
mkdir -p "$dst"
cp -R "$src/." "$dst/"
find "$dst" -name '*.woff' -delete
echo "sync-admin-ui: $(find "$dst" -type f | wc -l | tr -d ' ') files, $(du -sh "$dst" | cut -f1)"
