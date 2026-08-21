#!/bin/sh
# novamem CLI installer — fetches the release archive for this platform,
# verifies its checksum, and installs `novamem-init` and `novamem-mcp`
# side by side.
#
# They MUST land in the same directory: novamem-init resolves the MCP
# shim by looking for `novamem-mcp` beside its own executable, so a split
# install silently loses that path and falls back to $PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/azrtydxb/novamem/main/scripts/install.sh | sh
#
# Environment:
#   NOVAMEM_VERSION   tag to install (default: latest release)
#   NOVAMEM_BIN_DIR   install directory (default: ~/.local/bin)
#   NOVAMEM_BASE_URL  release download base (default: GitHub releases);
#                     overridable so the flow can be tested end to end
#                     against a local archive before anything is published
set -eu

REPO="azrtydxb/novamem"
BIN_DIR="${NOVAMEM_BIN_DIR:-$HOME/.local/bin}"

die() {
	echo "novamem-install: $*" >&2
	exit 1
}

need() {
	command -v "$1" >/dev/null 2>&1 || die "$1 is required"
}

need tar
if command -v curl >/dev/null 2>&1; then
	fetch() { curl -fsSL "$1" -o "$2"; }
	fetch_stdout() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
	fetch() { wget -qO "$2" "$1"; }
	fetch_stdout() { wget -qO- "$1"; }
else
	die "curl or wget is required"
fi

os=$(uname -s)
arch=$(uname -m)
case "$os" in
Linux) goos=linux ;;
Darwin) goos=darwin ;;
*) die "unsupported OS: $os (supported: Linux, Darwin)" ;;
esac
case "$arch" in
x86_64 | amd64) goarch=amd64 ;;
arm64 | aarch64) goarch=arm64 ;;
*) die "unsupported architecture: $arch (supported: x86_64, arm64)" ;;
esac
if [ "$goos" = darwin ] && [ "$goarch" = amd64 ]; then
	die "macOS on Intel is not a published target; build from source with: cd go && go build ./cmd/..."
fi

version="${NOVAMEM_VERSION:-}"
if [ -z "$version" ]; then
	# Resolve the latest tag without needing jq.
	version=$(fetch_stdout "https://api.github.com/repos/${REPO}/releases/latest" |
		sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
	[ -n "$version" ] || die "could not resolve the latest release; set NOVAMEM_VERSION"
fi

base="${NOVAMEM_BASE_URL:-https://github.com/${REPO}/releases/download/${version}}"
name="novamem_${version}_${goos}_${goarch}"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "→ downloading ${name}.tar.gz"
fetch "${base}/${name}.tar.gz" "${tmp}/${name}.tar.gz" || die "download failed: ${base}/${name}.tar.gz"

# Checksum is mandatory: a truncated or tampered archive must fail here,
# not later as a mystery crash inside an AI host.
if command -v sha256sum >/dev/null 2>&1; then
	sha_cmd="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
	sha_cmd="shasum -a 256"
else
	die "sha256sum or shasum is required to verify the download"
fi
fetch "${base}/${name}.tar.gz.sha256" "${tmp}/${name}.tar.gz.sha256" ||
	die "checksum file missing: ${base}/${name}.tar.gz.sha256"
expected=$(awk '{print $1}' "${tmp}/${name}.tar.gz.sha256")
actual=$($sha_cmd "${tmp}/${name}.tar.gz" | awk '{print $1}')
[ "$expected" = "$actual" ] || die "checksum mismatch (expected $expected, got $actual)"
echo "✓ checksum verified"

tar -C "$tmp" -xzf "${tmp}/${name}.tar.gz"
mkdir -p "$BIN_DIR"
for bin in novamem-init novamem-mcp; do
	[ -f "${tmp}/${name}/${bin}" ] || die "archive is missing ${bin}"
	install -m 0755 "${tmp}/${name}/${bin}" "${BIN_DIR}/${bin}"
done

echo "✓ installed novamem-init and novamem-mcp to ${BIN_DIR}"
case ":${PATH}:" in
*":${BIN_DIR}:"*) ;;
*) echo "  note: ${BIN_DIR} is not on your PATH — add it, e.g.  export PATH=\"${BIN_DIR}:\$PATH\"" ;;
esac
echo
echo "Next: novamem-init --base-url https://your-novamem-server"
