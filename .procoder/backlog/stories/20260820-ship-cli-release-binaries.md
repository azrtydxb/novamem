# Ship novamem-mcp and novamem-init as release binaries

Status: open
Created: 2026-08-20
Epic: mcp-shim-to-go
Sprint: -

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

- [ ] release workflow cross-compiles both binaries for the three targets and attaches them to the GitHub release
- [ ] an install script places both on PATH and is documented
- [ ] a downloaded archive keeps the two binaries side by side (the init CLI's sibling-resolution path works from it)
- [ ] checksums published with the archives

## Evidence
