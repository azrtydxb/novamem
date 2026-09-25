# 0010 — Swift and PHP SDKs ship through read-only mirror repos

Status: accepted
Date: 2026-09-25

## Context

ADR 0009 puts every SDK in the monorepo under `clients/<lang>`, released by a
`clients/<lang>/vX.Y.Z` tag. Planning the release workflows showed that two of
the nine registries cannot consume that layout. SwiftPM resolves a package only
from a repository whose root holds the package manifest, and it takes versions
only from root-level semver tags. Packagist reads the Composer manifest only
from a repository root too. The other seven channels publish a built artifact,
so for them the source layout doesn't matter.

## Decision

`clients/swift` and `clients/php` stay in the monorepo as the source of
truth. On each release tag, the release workflow runs `git subtree split` for
that directory and pushes the result to a read-only mirror:
`azrtydxb/novamem-swift` (tagged `X.Y.Z`, as SwiftPM expects) or
`azrtydxb/novamem-php` (tagged `vX.Y.Z`, registered on Packagist). The mirrors
take no issues or PRs; their README points to the monorepo.

Rejected: root-level `Package.swift` and `composer.json` in the monorepo. It
needs no new repos, but root `X.Y.Z` tags would become Swift and PHP versions
next to the server's `vX.Y.Z`. Every `composer require` would also download
the whole monorepo unless a growing `.gitattributes` export-ignore list
trimmed it.

## Consequences

Easier: Swift and PHP consumers get ordinary version resolution
(`from: "0.1.0"`, `^0.1`), and the monorepo keeps one tag scheme.

Harder: two more repositories to own, and a fine-grained
`SDK_MIRROR_TOKEN` with write access to exactly those two. A push that fails
between the split and the tag leaves a mirror commit with no tag, which the
next release overwrites. Nobody may commit to a mirror directly, because the
next split would force over their change.
