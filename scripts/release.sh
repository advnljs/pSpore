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

Produces:
  - pspore-<version>-linux-x64       standalone CLI binary (no Node required)
  - pspore-desktop-<version>-linux-x64.AppImage  Electron desktop app

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

if ! command -v gh &>/dev/null; then
  echo "Error: gh (GitHub CLI) is required. Install: https://cli.github.com/"
  exit 1
fi

NODE_VERSION=$(node --version 2>/dev/null || true)
if [[ -z "$NODE_VERSION" ]]; then
  echo "Error: node is required (>= 24)"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

TAG="v${VERSION}"
echo "==> Building release ${TAG}"

# ─── Install & Build ───────────────────────────────────────────────
echo "--- npm install"
npm ci 2>/dev/null || npm install

echo "--- npm run build"
npm run build

# ─── Prepare output dir ───────────────────────────────────────────
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# ─── CLI Binary via Node SEA ──────────────────────────────────────
echo "--- Bundling CLI with esbuild"
npx --yes esbuild dist/cli/main.js \
  --bundle \
  --platform=node \
  --target=node24 \
  --format=esm \
  --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);" \
  --outfile="$DIST_DIR/pspore-bundle.mjs" \
  --external:electron

echo "--- Generating Node SEA blob"
SEA_CONFIG="$DIST_DIR/sea-config.json"
cat > "$SEA_CONFIG" <<SEACFG
{
  "main": "$DIST_DIR/pspore-bundle.mjs",
  "output": "$DIST_DIR/pspore.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": true
}
SEACFG

node --experimental-sea-config "$SEA_CONFIG"

echo "--- Injecting SEA blob into node binary"
BINARY_NAME="pspore-${VERSION}-linux-x64"
cp "$(command -v node)" "$DIST_DIR/$BINARY_NAME"
chmod 755 "$DIST_DIR/$BINARY_NAME"

npx --yes postject "$DIST_DIR/$BINARY_NAME" NODE_SEA_BLOB "$DIST_DIR/pspore.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

echo "--- CLI binary ready: $BINARY_NAME"

# ─── Electron Desktop via electron-builder ────────────────────────
ARTIFACT_ELECTRON=""
if [[ -d "dist/desktop" ]]; then
  echo "--- Building Electron AppImage with electron-builder"

  BUILDER_CFG="$DIST_DIR/electron-builder.json"
  cat > "$BUILDER_CFG" <<BUILDCFG
{
  "appId": "com.pspore.desktop",
  "productName": "pSpore",
  "directories": {
    "output": "$DIST_DIR/electron-out"
  },
  "files": [
    "dist/**/*",
    "node_modules/**/*",
    "package.json"
  ],
  "linux": {
    "target": ["AppImage"],
    "category": "Utility",
    "icon": null
  },
  "extraMetadata": {
    "main": "dist/desktop/main.js",
    "version": "$VERSION"
  }
}
BUILDCFG

  npx --yes electron-builder --linux AppImage \
    --project "$REPO_ROOT" \
    --config "$BUILDER_CFG" \
    || echo "Warning: electron-builder failed, skipping desktop binary"

  APPIMAGE=$(find "$DIST_DIR/electron-out" -name "*.AppImage" 2>/dev/null | head -1)
  if [[ -n "$APPIMAGE" ]]; then
    ARTIFACT_ELECTRON="pspore-desktop-${VERSION}-linux-x64.AppImage"
    mv "$APPIMAGE" "$DIST_DIR/$ARTIFACT_ELECTRON"
    chmod +x "$DIST_DIR/$ARTIFACT_ELECTRON"
    echo "--- Electron AppImage ready: $ARTIFACT_ELECTRON"
  fi
fi

# ─── Tag & Release ────────────────────────────────────────────────
echo "--- Tagging ${TAG}"
git tag -a "$TAG" -m "Release ${TAG}"
git push origin "$TAG"

echo "--- Creating GitHub release"
RELEASE_NOTES="## pSpore ${TAG}

### CLI Binary

Download \`${BINARY_NAME}\`, make executable, and run:

\`\`\`bash
chmod +x ${BINARY_NAME}
./${BINARY_NAME} version
# Move to PATH:
sudo mv ${BINARY_NAME} /usr/local/bin/pspore
\`\`\`

No Node.js runtime required — fully self-contained single binary.

### Desktop (Electron)

Download the AppImage, make executable, and run:

\`\`\`bash
chmod +x ${ARTIFACT_ELECTRON:-pspore-desktop-*-linux-x64.AppImage}
./${ARTIFACT_ELECTRON:-pspore-desktop-*-linux-x64.AppImage}
\`\`\`

### Platform

- Linux x86_64
"

GH_ARGS=(
  "$TAG"
  --title "pSpore ${TAG}"
  --notes "$RELEASE_NOTES"
)

if [[ "$PRERELEASE" == "--prerelease" ]]; then
  GH_ARGS+=(--prerelease)
fi

UPLOAD_FILES=("$DIST_DIR/$BINARY_NAME")
if [[ -n "$ARTIFACT_ELECTRON" && -f "$DIST_DIR/$ARTIFACT_ELECTRON" ]]; then
  UPLOAD_FILES+=("$DIST_DIR/$ARTIFACT_ELECTRON")
fi

gh release create "${GH_ARGS[@]}" "${UPLOAD_FILES[@]}"

echo ""
echo "==> Release ${TAG} published!"
echo "    Artifacts:"
echo "      - ${BINARY_NAME} (standalone CLI)"
if [[ -n "$ARTIFACT_ELECTRON" ]]; then
  echo "      - ${ARTIFACT_ELECTRON} (Electron desktop)"
fi
echo ""
echo "    View: gh release view ${TAG}"

# Cleanup build intermediates
rm -f "$DIST_DIR/pspore-bundle.mjs" "$DIST_DIR/pspore.blob" "$SEA_CONFIG"
rm -f "$BUILDER_CFG"
rm -rf "$DIST_DIR/electron-out"

echo "==> Done. Artifacts in: $DIST_DIR"
