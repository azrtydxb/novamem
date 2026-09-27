#!/usr/bin/env bash
# Run from CI's disposable checkout only, after registry verification.
set -euo pipefail

: "${GITHUB_SHA:?source commit required}"
: "${IMAGE_TAG:?verified image tag required}"
: "${REGISTRY_IMAGE:?image repository required}"
if [[ "${GITHUB_ACTIONS:-}" != true ]]; then
  echo "This script resets its checkout; run it only in GitHub Actions" >&2
  exit 1
fi
if [[ "$IMAGE_TAG" != "sha-${GITHUB_SHA:0:7}" ]]; then
  echo "Image tag must identify the source commit" >&2
  exit 1
fi

export KW_DEPLOYMENT=deploy/overlays/kw/deployment.yaml
export KW_IMAGE="${REGISTRY_IMAGE}:${IMAGE_TAG}"
# Keep this script available across resets to a newer main commit.
for attempt in 1 2 3; do
  git fetch --quiet origin main
  git reset --hard --quiet origin/main
  current=$(sed -n 's/^[[:space:]]*image: \([^ ]*\).*/\1/p' "$KW_DEPLOYMENT")
  if [[ "$current" == "$KW_IMAGE" ]]; then
    echo "$KW_DEPLOYMENT already names $IMAGE_TAG"
    exit 0
  fi
  recorded="${current##*:sha-}"
  if [[ "$recorded" =~ ^[0-9a-f]{7,40}$ ]] &&
    git merge-base --is-ancestor "$GITHUB_SHA" "$recorded" 2>/dev/null; then
    echo "$current includes this build already; preserving the newer image"
    exit 0
  fi
  if ! git merge-base --is-ancestor "$GITHUB_SHA" HEAD; then
    echo "Source commit is no longer on main; refusing to record it" >&2
    exit 1
  fi
  python3 - <<'PY'
import os
import pathlib
import re

path = pathlib.Path(os.environ["KW_DEPLOYMENT"])
text, count = re.subn(
    r"(?m)^(\s*image: )\S+(.*)$",
    lambda match: match[1] + os.environ["KW_IMAGE"] + match[2],
    path.read_text(),
)
if count != 1:
    raise SystemExit(f"Expected exactly one image in {path}, found {count}")
path.write_text(text)
PY
  git config user.name "novamem ci"
  git config user.email "ci@kuvryn.invalid"
  git add "$KW_DEPLOYMENT"
  git commit --quiet -m "Deploy $IMAGE_TAG to kw [skip ci]" \
    -m "Written by CI after the multi-arch image was pushed and verified."
  if git push --quiet origin HEAD:main; then
    echo "Recorded $IMAGE_TAG on main for Kuvryn Sync"
    exit 0
  fi
  echo "Push rejected; rebuilding the pin from origin (attempt $attempt)"
  sleep 5
done
echo "Could not record $IMAGE_TAG on main" >&2
exit 1
