---
title: Release flow
---

# Release flow

novamem has two parallel release pathways:

- **npm packages** — versioned via [Changesets](https://github.com/changesets/changesets), published to npm
- **Server image** — versioned via manual `vX.Y.Z` tags, published to ghcr.io

## npm packages (Changesets)

The published packages: `@azrtydxb/novamem`, `@azrtydxb/novamem-mcp`, `@azrtydxb/novamem-init`. The `mcp` and `init` packages are `linked` so they bump together.

### Workflow

1. **Add a changeset** in your PR:

   ```bash
   pnpm changeset
   ```

   Pick the package(s), the bump type (patch / minor / major), and write the changelog line.

2. **Merge** the PR. The Release workflow opens or updates a "Version Packages" PR with the bumps applied.

3. **Merge the Version Packages PR.** The Release workflow runs `pnpm changeset publish` with `NPM_CONFIG_PROVENANCE=true` (Trusted Publishers, no token).

4. The release tag is `@azrtydxb/<pkg>@X.Y.Z`. GitHub Releases auto-created from the changelog.

### Notes

- Server (`@azrtydxb/novamem-server`) is in the `ignore` list in `.changeset/config.json` — Changesets won't bump it. It's released manually (see below).
- npm publishes use Trusted Publishers (OIDC). No token in the workflow.
- Node 24 is required for `npm publish` PUT auth — Node 22 ships npm 10 which lacks it.

## Server image (manual vX.Y.Z)

The server isn't published to npm. The release artifact is the docker image.

### Workflow

1. **Branch** off main: `chore/release-vX.Y.Z`.
2. **Bump** the `version` in the OpenAPI info block (`go/internal/httpapi/openapi_routes.go`) and regenerate with `cd go && go run ./cmd/gen-openapi`. The release tag is what names the image; this keeps the served spec honest about which release it is.
3. **Open PR** + auto-merge. CI runs the test suite.
4. **Tag** on the merge commit:

   ```bash
   git tag vX.Y.Z <sha>
   git push origin vX.Y.Z
   ```

5. **Create the release** with `gh release create vX.Y.Z` and notes summarising the included PRs since the previous tag.
6. **Image** is at `ghcr.io/azrtydxb/novamem:sha-<short>`. The `:main` tag also points at the latest main.

### Tag conventions

| Tag | What |
|---|---|
| `vX.Y.Z` | Server release. Repo-wide. |
| `@azrtydxb/<pkg>@X.Y.Z` | Per-package npm release. |
| `:main` | Always-latest main. Don't use in production. |
| `:sha-<7chars>` | Deterministic. Pin in production. |

## Branch protection

`main` requires:

- 6 status checks green: `test (amd64)`, `test (arm64)`, `audit`, `package npm`, `docker amd64`, `docker arm64`
- Branch up-to-date with `main` before merge (`strict: true`)
- 1 approving review (or auto-approve via `enable-automerge` for fix-up PRs)

Auto-merge does NOT auto-update branches that fall BEHIND. If a PR sits BEHIND because main moved, run `gh pr update-branch <N>` manually.

## When something fails to publish

- **npm 404** on publish — the package is on Trusted Publishers but the workflow ran with an old npm. Make sure `setup-node` uses `node-version: 24`.
- **`workspace:*` in published tarball** — happens if you publish via `npm publish` directly. Always use `pnpm publish` (or `pnpm changeset publish`), which rewrites workspace protocol entries.
- **Docker push fails on attestation manifest** — the workflow uses `docker/build-push-action` with `push: true` after Trivy. Don't `docker tag` + `docker push` on a `--load`'d image; the attestation manifest gets stripped.

## Reading the release page

Each server release lists:

1. **Summary** — one-line "what's new"
2. **Changes since previous tag** — bullet list with PR links
3. **Image** — pinnable tag for k8s `set image`
4. **Compatibility** — "no breaking changes" or specific notes if there are
5. **Verification** — how the release was tested (often: deployed to home cluster + MCP smoke test)
