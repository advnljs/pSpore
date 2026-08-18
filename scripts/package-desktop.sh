#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

EXPECTED_VERSION="${1:-}"
ELECTRON_BUILDER_VERSION="${ELECTRON_BUILDER_VERSION:-26.15.3}"
DIST_DIR="$REPO_ROOT/release-dist"
VERSION="$(node -p "require('./package.json').version")"
APPIMAGE_NAME="pspore-desktop-${VERSION}-linux-x64.AppImage"
APPIMAGE_PATH="$DIST_DIR/$APPIMAGE_NAME"

if [[ -n "$EXPECTED_VERSION" && "$EXPECTED_VERSION" != "$VERSION" ]]; then
  echo "Error: package.json version ${VERSION} does not match expected ${EXPECTED_VERSION}"
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

echo "==> Packaging desktop AppImage ${APPIMAGE_NAME}"
echo "--- npm run build"
npm run build

mkdir -p "$DIST_DIR"
rm -rf "$DIST_DIR/electron-out"
rm -f "$APPIMAGE_PATH" "$APPIMAGE_PATH.sha256"

echo "--- electron-builder@${ELECTRON_BUILDER_VERSION} linux AppImage"
npx --yes "electron-builder@${ELECTRON_BUILDER_VERSION}" \
  --linux AppImage \
  --x64 \
  --publish never \
  --config electron-builder.yml

if [[ ! -f "$DIST_DIR/electron-out/$APPIMAGE_NAME" ]]; then
  echo "Error: electron-builder did not produce $APPIMAGE_NAME"
  echo "--- electron-out contents ---"
  ls -la "$DIST_DIR/electron-out" || true
  exit 1
fi

mv "$DIST_DIR/electron-out/$APPIMAGE_NAME" "$APPIMAGE_PATH"
chmod 755 "$APPIMAGE_PATH"
(
  cd "$DIST_DIR"
  sha256sum "$APPIMAGE_NAME" | tee "$APPIMAGE_NAME.sha256"
)

rm -rf "$DIST_DIR/electron-out"

echo "==> AppImage ready: $APPIMAGE_PATH ($(du -h "$APPIMAGE_PATH" | cut -f1))"
