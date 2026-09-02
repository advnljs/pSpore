#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

VERSION="${1:-}"
PRERELEASE="${2:-}"
DIST_DIR="$REPO_ROOT/release-dist"

usage() {
  cat <<EOF
Usage: $0 <version> [--prerelease]

Builds and validates the Linux x86_64 release candidate, creates an immutable
version tag, and pushes it. GitHub Actions then publishes x64 and ARM64 assets.

Examples:
  $0 0.1.0
  $0 0.2.0-alpha.1 --prerelease

Prerequisites:
  - gh (GitHub CLI) authenticated
  - node >= 24
  - npm
  - git clean working tree
EOF
  exit 1
}

if [[ -z "$VERSION" ]]; then
  usage
fi
if [[ -n "$PRERELEASE" && "$PRERELEASE" != "--prerelease" ]]; then
  usage
fi
if [[ "$PRERELEASE" == "--prerelease" && "$VERSION" != *-* ]]; then
  echo "Error: --prerelease requires a SemVer prerelease suffix such as -rc.1"
  exit 1
fi

if ! command -v gh &>/dev/null; then
  echo "Error: gh (GitHub CLI) is required. Install: https://cli.github.com/"
  exit 1
fi

if ! command -v node >/dev/null; then
  echo "Error: node >= 24 is required"
  exit 1
fi
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 24 ]]; then
  echo "Error: node >= 24 is required (found $(node -v))"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

TAG="v${VERSION}"
BINARY_NAME="pspore-${VERSION}-linux-x64"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"

if [[ "$PACKAGE_VERSION" != "$VERSION" ]]; then
  echo "Error: requested version ${VERSION} does not match package.json ${PACKAGE_VERSION}"
  exit 1
fi
if git show-ref --verify --quiet "refs/tags/$TAG" \
  || git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1 \
  || gh release view "$TAG" >/dev/null 2>&1; then
  echo "Error: immutable release ${TAG} already exists. Bump the SemVer version instead of overwriting it."
  exit 1
fi

echo "==> Building release ${TAG}"

# ─── Install, verify, and package ─────────────────────────────────
echo "--- npm ci"
npm ci

echo "--- npm run check"
npm run check

rm -rf "$DIST_DIR"
FULL_ZIP_NAME="pspore-desktop-${VERSION}-linux-x64.zip"
OVERLAY_ZIP_NAME="pspore-desktop-${VERSION}-linux-x64-overlay.zip"
echo "--- Building Electron desktop zips and standalone CLI"
bash "$REPO_ROOT/scripts/package-desktop.sh" "$VERSION"

REQUIRED_ASSETS=(
  "$DIST_DIR/$BINARY_NAME"
  "$DIST_DIR/$BINARY_NAME.sha256"
  "$DIST_DIR/$FULL_ZIP_NAME"
  "$DIST_DIR/$FULL_ZIP_NAME.sha256"
  "$DIST_DIR/$OVERLAY_ZIP_NAME"
  "$DIST_DIR/$OVERLAY_ZIP_NAME.sha256"
)
for asset in "${REQUIRED_ASSETS[@]}"; do
  if [[ ! -f "$asset" ]]; then
    echo "Error: release package is missing ${asset}"
    exit 1
  fi
done
if [[ ! -x "$DIST_DIR/pspore-desktop-${VERSION}-linux-x64/pspore-desktop" ]]; then
  echo "Error: runnable desktop package is missing"
  exit 1
fi

# ─── Immutable tag; GitHub Actions publishes the release ─────────
echo "--- Tagging ${TAG}"
git tag -a "$TAG" -m "Release ${TAG}"
git push origin "$TAG"
echo "==> Tag ${TAG} pushed. GitHub Actions is building immutable x64 and ARM64 Release assets."
echo "    Track: gh run list --workflow 'Release desktop' --branch ${TAG}"
