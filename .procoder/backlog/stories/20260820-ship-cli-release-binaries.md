# Ship novamem-mcp and novamem-init as release binaries

Status: done 2026-08-21
Created: 2026-08-20
Epic: mcp-shim-to-go
Sprint: 005-go-cli-tools-are-shippable-artifacts-and-the-last-operator

## Description

ADR 0001 chose GitHub-release binaries plus an install script as the
channel for the Go CLI tools, but nothing builds them: release.yml only
runs the Changesets npm publish, and CI's only binary artifact is the
server image. Until this lands, the channel the ADR picked does not
exist, so the docs cannot honestly tell anyone to use it — which is why
the docs half of 20260820-mcp-shim-distribution-decision is blocked on
this story rather than shipped alongside the port.

Cross-compile `novamem-mcp` and `novamem-init` for linux/amd64,
linux/arm64, darwin/arm64 (matching the server's existing release
targets), attach them to the `vX.Y.Z` GitHub release, and provide an
install script that drops both on PATH. The two binaries must land in
the same archive: the init CLI resolves the shim as a sibling of its own
executable, so shipping them apart breaks that resolution path.

## Acceptance criteria

- [x] release workflow cross-compiles both binaries for the three targets and attaches them to the GitHub release
- [x] an install script places both on PATH and is documented
- [x] a downloaded archive keeps the two binaries side by side (the init CLI's sibling-resolution path works from it)
- [x] checksums published with the archives

## Evidence

- .github/workflows/release-binaries.yml: matrix over linux/amd64, linux/arm64, darwin/arm64 on the same vX.Y.Z tag that releases the server image; CGO_ENABLED=0, -trimpath, version stamped from the tag; uploads via the gh CLI rather than a third-party action (one less supply-chain surface). actionlint clean.
- All three targets cross-compiled locally and archived (4.8–5.3 MB each); the linux/arm64 binary verifies as "ELF 64-bit LSB executable, ARM aarch64 … statically linked".
- FULL INSTALL FLOW EXERCISED without publishing anything: the archives were served over local HTTP and scripts/install.sh (NOVAMEM_BASE_URL override, which exists for exactly this) selected the right platform archive, verified the checksum, and installed both binaries.
- The criterion that matters: the INSTALLED novamem-init, run with NO --mcp-bin flag, resolved its sibling and wrote `"command": "<install-dir>/novamem-mcp"` into the Claude Desktop config, and the pre-flight ran that binary successfully. Splitting the archive would have broken this.
- Checksums: generated per archive and verified on install; negative test — appending a byte to the archive produced "checksum mismatch (expected …, got …)", exit 1, and ZERO files installed.
- `--version` reports the stamped tag (v0.0.0-test) from the built binary.
- Documented in packages/docs-site/contribute/releases.md (workflow, the same-archive rule and why, install command, env overrides, the unsupported darwin/amd64 target); vitepress build green.
- NOT published: cutting a real release is a tagged, outward-facing action and the owner's call. The workflow fires on the next vX.Y.Z tag.
