---
title: Release flow
---

# Release flow

novamem has two parallel release pathways:

- **CLI binaries** (`novamem-init`, `novamem-mcp`) — built by CI from a `vX.Y.Z` tag and attached to the GitHub release
- **Server image** — versioned via manual `vX.Y.Z` tags, published to ghcr.io

## npm packages — retired

npm publishing is no longer part of this repo. `@azrtydxb/novamem`
(client), `@azrtydxb/novamem-mcp` (stdio shim) and
`@azrtydxb/novamem-init` (installer) were superseded by Go binaries and
removed, along with Changesets and the npm release workflow. Every
remaining workspace package is private, so there is nothing to publish.

Versions already on npm stay published and keep working; they get no
successors. What ships now is the **server image** and the **CLI
binaries** — see the two sections below.

## Server image (manual vX.Y.Z)

The server isn't published to npm. The release artifact is the docker image.

### Workflow

1. **Branch** off main: `chore/release-vX.Y.Z`.
2. **Bump** the `version` in the OpenAPI info block (`api/openapi.yaml`) and regenerate with `cd go && go run ./cmd/gen-contract`. The release tag is what names the image; this keeps the served spec honest about which release it is.
3. **Open PR** + auto-merge. CI runs the test suite.
4. **Tag** on the merge commit:

   ```bash
   git tag vX.Y.Z <sha>
   git push origin vX.Y.Z
   ```

5. **Create the release** with `gh release create vX.Y.Z` and notes summarising the included PRs since the previous tag.
6. **Image** is at `ghcr.io/azrtydxb/novamem:sha-<short>`. The `:main` tag also points at the latest main.

### Tag conventions

| Tag             | What                                         |
| --------------- | -------------------------------------------- |
| `vX.Y.Z`        | Server release. Repo-wide.                   |
| `:main`         | Always-latest main. Don't use in production. |
| `:sha-<7chars>` | Deterministic. Pin in production.            |

## CLI binaries (novamem-init, novamem-mcp)

Per [ADR 0001](https://github.com/azrtydxb/novamem/blob/main/.procoder/adr/0001-go-tool-distribution-via-github-releases.md)
the Go CLI tools ship as release binaries, not npm packages.

### Workflow

`release-binaries.yml` runs on the same `vX.Y.Z` tag that releases the
server image. For each of `linux/amd64`, `linux/arm64` and
`darwin/arm64` it cross-compiles both binaries (`CGO_ENABLED=0`, so they
are static and run on glibc or musl alike), stamps `--version` from the
tag, and attaches one archive plus its `.sha256` to the GitHub release.

**Both binaries ride in the same archive on purpose.** `novamem-init`
resolves the MCP shim by looking for `novamem-mcp` beside its own
executable; splitting them would silently drop that path and fall back
to whatever is on `$PATH`.

### Installing

```bash
curl -fsSL https://raw.githubusercontent.com/azrtydxb/novamem/main/scripts/install.sh | sh
```

The script picks the archive for the running platform, **verifies the
checksum before unpacking** (a truncated or tampered download fails
here, not later as a mystery crash inside an AI host), and installs both
binaries into `~/.local/bin`. Environment overrides:
`NOVAMEM_VERSION` (default: latest release), `NOVAMEM_BIN_DIR`, and
`NOVAMEM_BASE_URL` — the last exists so the whole flow can be exercised
against a locally served archive before anything is published.

macOS on Intel is not a published target; build from source with
`cd go && go build ./cmd/...`.

## Branch protection

`main` requires:

- every status check green, including `go (build + vet + test)`, `audit`, `docker (amd64)` and `docker (arm64)`
- Branch up-to-date with `main` before merge (`strict: true`)
- 1 approving review (or auto-approve via `enable-automerge` for fix-up PRs)

Auto-merge does NOT auto-update branches that fall BEHIND. If a PR sits BEHIND because main moved, run `gh pr update-branch <N>` manually.

## When something fails to publish

- **Docker push fails on attestation manifest** — the workflow uses `docker/build-push-action` with `push: true` after Trivy. Don't `docker tag` + `docker push` on a `--load`'d image; the attestation manifest gets stripped.

## Reading the release page

Each server release lists:

1. **Summary** — one-line "what's new"
2. **Changes since previous tag** — bullet list with PR links
3. **Image** — pinnable tag for k8s `set image`
4. **Compatibility** — "no breaking changes" or specific notes if there are
5. **Verification** — how the release was tested (often: deployed to home cluster + MCP smoke test)
