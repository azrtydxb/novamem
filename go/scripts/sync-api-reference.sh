#!/usr/bin/env bash
# Refresh the vendored API-reference renderer (Scalar) that the server
# serves at /api-docs.
#
# The bundle is vendored rather than pulled from a CDN at page load:
# novamem is deployed air-gapped and behind strict egress policies, and a
# reference page that renders blank without internet is worse than none.
# It is stored gzipped — 1.0 MB instead of 3.7 MB in the repo and in the
# binary — and served with Content-Encoding: gzip.
#
# Usage:
#   go/scripts/sync-api-reference.sh            # latest
#   go/scripts/sync-api-reference.sh 1.68.0     # a specific version
#
# Commit both files together: VERSION is what the handler puts in the
# ETag, so a bundle that moves without it serves stale caches forever.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="$here/../internal/httpapi/apidocs"

version="${1:-}"
if [ -z "$version" ]; then
	version="$(curl -fsSL https://registry.npmjs.org/@scalar/api-reference/latest |
		python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
fi

url="https://cdn.jsdelivr.net/npm/@scalar/api-reference@${version}/dist/browser/standalone.js"
echo "fetching @scalar/api-reference@${version}"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp"

# A CDN 404 page is still a 200 for some mirrors; refuse anything that is
# not plausibly the bundle rather than embedding an HTML error page.
bytes="$(wc -c <"$tmp" | tr -d ' ')"
if [ "$bytes" -lt 1000000 ]; then
	echo "refusing: downloaded ${bytes} bytes, expected a multi-MB bundle" >&2
	exit 1
fi

mkdir -p "$dest"
gzip -9 -c "$tmp" >"$dest/standalone.js.gz"
echo "$version" >"$dest/VERSION"

echo "wrote $dest/standalone.js.gz ($(wc -c <"$dest/standalone.js.gz" | tr -d ' ') bytes, from ${bytes})"
echo "wrote $dest/VERSION ($version)"
echo
echo "next: cd go && go test ./internal/httpapi/ -run APIReference"
