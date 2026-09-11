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
# This vendors third-party JavaScript into a binary that serves it to
# operators' browsers, so nothing here is taken on trust:
#
#   1. The package tarball comes from the npm registry, not a CDN mirror.
#   2. Its sha512 is checked against the registry's own `dist.integrity`
#      before anything is unpacked. A mismatch aborts.
#   3. The sha256 of the extracted bundle is written next to it, so a
#      reviewer can recompute what was committed without re-downloading.
#
# Usage:
#   go/scripts/sync-api-reference.sh            # latest
#   go/scripts/sync-api-reference.sh 1.68.0     # a specific version
#
# Commit VERSION, SHA256, standalone.js.gz and the docs-site dependency
# bump together: the version is in the bundle's URL and its ETag, and
# scripts/doc-smoke.mjs fails if the site and the server disagree about it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
dest="$here/../internal/httpapi/apidocs"
pkg="@scalar/api-reference"

version="${1:-}"
if [ -z "$version" ]; then
	version="$(curl -fsSL "https://registry.npmjs.org/${pkg}/latest" |
		python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
fi
echo "syncing ${pkg}@${version}"

meta="$(curl -fsSL "https://registry.npmjs.org/${pkg}/${version}")"
tarball="$(printf '%s' "$meta" | python3 -c 'import json,sys; print(json.load(sys.stdin)["dist"]["tarball"])')"
integrity="$(printf '%s' "$meta" | python3 -c 'import json,sys; print(json.load(sys.stdin)["dist"]["integrity"])')"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl -fsSL "$tarball" -o "$work/pkg.tgz"

# The registry publishes `sha512-<base64>`; recompute and compare.
want="${integrity#sha512-}"
got="$(python3 -c '
import base64, hashlib, sys
print(base64.b64encode(hashlib.sha512(open(sys.argv[1], "rb").read()).digest()).decode())
' "$work/pkg.tgz")"
if [ "$got" != "$want" ]; then
	echo "refusing: tarball sha512 does not match the registry's dist.integrity" >&2
	echo "  want $want" >&2
	echo "  got  $got" >&2
	exit 1
fi
echo "verified tarball against registry dist.integrity"

tar -xzf "$work/pkg.tgz" -C "$work" package/dist/browser/standalone.js
src="$work/package/dist/browser/standalone.js"

bytes="$(wc -c <"$src" | tr -d ' ')"
if [ "$bytes" -lt 1000000 ]; then
	echo "refusing: extracted ${bytes} bytes, expected a multi-MB bundle" >&2
	exit 1
fi

mkdir -p "$dest"
gzip -9 -c "$src" >"$dest/standalone.js.gz"
printf '%s\n' "$version" >"$dest/VERSION"
shasum -a 256 "$src" | awk '{print $1}' >"$dest/SHA256"

echo "wrote $dest/standalone.js.gz ($(wc -c <"$dest/standalone.js.gz" | tr -d ' ') bytes, from ${bytes})"
echo "wrote $dest/VERSION  ($version)"
echo "wrote $dest/SHA256   ($(cat "$dest/SHA256"))"
echo
echo "now bump the site to the same version so the two renderers agree:"
echo "  pnpm --filter @azrtydxb/novamem-docs-site add -D ${pkg}@${version}"
echo "then: cd go && go test ./internal/httpapi/ -run APIReference && pnpm docs:smoke"
