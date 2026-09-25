# SDK T17: release workflows

Status: open
Created: 2026-09-25

## Description

Add one tag-triggered release workflow per SDK (clients/<lang>/vX.Y.Z), the mirror push for PHP and Swift, the tag-trigger guard, and dependabot coverage (plan Task 17, spec S-14).

## Acceptance criteria

- [ ] `actionlint .github/workflows/release-sdk-*.yml` exits 0
- [ ] `sh scripts/check-sdk-tag-triggers.sh` exits 0, and fails when a release-sdk tag pattern is changed to `v*`
- [ ] The registry-name availability checks are recorded in the PR description; any name taken by someone else was put to the user
- [ ] Mirror repos, SDK_MIRROR_TOKEN and Packagist registration were each confirmed with the user before being created

## Evidence
