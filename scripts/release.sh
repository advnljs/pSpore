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

if ! command -v node &>/dev/null; then
  echo "Error: node is required (>= 24)"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first."
  exit 1
fi

TAG="v${VERSION}"
echo "==> Building release ${TAG}"

# Build
echo "--- npm install (production deps)"
npm ci --ignore-scripts 2>/dev/null || npm install
echo "--- npm run build"
npm run build

# Prepare release artifacts directory
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR/pspore-${VERSION}"

# Copy built output
cp -r dist "$DIST_DIR/pspore-${VERSION}/"
cp package.json "$DIST_DIR/pspore-${VERSION}/"
cp package-lock.json "$DIST_DIR/pspore-${VERSION}/" 2>/dev/null || true

# Install production-only node_modules into the release
cd "$DIST_DIR/pspore-${VERSION}"
npm install --omit=dev --ignore-scripts 2>/dev/null || npm install --production --ignore-scripts
cd "$REPO_ROOT"

# Create launcher script
cat > "$DIST_DIR/pspore-${VERSION}/pspore" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/dist/cli/main.js" "$@"
LAUNCHER
chmod +x "$DIST_DIR/pspore-${VERSION}/pspore"

# Create tarball
ARTIFACT_CLI="pspore-${VERSION}-linux-x64.tar.gz"
echo "--- Creating ${ARTIFACT_CLI}"
cd "$DIST_DIR"
tar -czf "$ARTIFACT_CLI" "pspore-${VERSION}/"
cd "$REPO_ROOT"

# Electron AppImage (if electron-builder available, otherwise package as tarball)
ARTIFACT_ELECTRON=""
if command -v npx &>/dev/null && [[ -d "dist/desktop" ]]; then
  echo "--- Creating Electron desktop tarball"
  ARTIFACT_ELECTRON="pspore-desktop-${VERSION}-linux-x64.tar.gz"
  mkdir -p "$DIST_DIR/pspore-desktop-${VERSION}"
  cp -r dist "$DIST_DIR/pspore-desktop-${VERSION}/"
  cp package.json "$DIST_DIR/pspore-desktop-${VERSION}/"
  cp -r node_modules "$DIST_DIR/pspore-desktop-${VERSION}/"
  cat > "$DIST_DIR/pspore-desktop-${VERSION}/pspore-desktop" <<'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec npx electron "$SCRIPT_DIR/dist/desktop/main.js" "$@"
LAUNCHER
  chmod +x "$DIST_DIR/pspore-desktop-${VERSION}/pspore-desktop"
  cd "$DIST_DIR"
  tar -czf "$ARTIFACT_ELECTRON" "pspore-desktop-${VERSION}/"
  cd "$REPO_ROOT"
fi

# Create git tag
echo "--- Tagging ${TAG}"
git tag -a "$TAG" -m "Release ${TAG}"
git push origin "$TAG"

# Create GitHub release
echo "--- Creating GitHub release"
RELEASE_NOTES="## pSpore ${TAG}

### Installation (CLI)

\`\`\`bash
tar -xzf ${ARTIFACT_CLI}
cd pspore-${VERSION}
./pspore version
# Optionally add to PATH:
# ln -s \$(pwd)/pspore ~/.local/bin/pspore
\`\`\`

### Requirements

- Linux x86_64
- Node.js >= 24 (bundled node_modules, but node runtime required)
"

GH_ARGS=(
  "$TAG"
  --title "pSpore ${TAG}"
  --notes "$RELEASE_NOTES"
)

if [[ "$PRERELEASE" == "--prerelease" ]]; then
  GH_ARGS+=(--prerelease)
fi

UPLOAD_FILES=("$DIST_DIR/$ARTIFACT_CLI")
if [[ -n "$ARTIFACT_ELECTRON" && -f "$DIST_DIR/$ARTIFACT_ELECTRON" ]]; then
  UPLOAD_FILES+=("$DIST_DIR/$ARTIFACT_ELECTRON")
fi

gh release create "${GH_ARGS[@]}" "${UPLOAD_FILES[@]}"

echo ""
echo "==> Release ${TAG} published!"
echo "    Artifacts:"
echo "      - ${ARTIFACT_CLI}"
if [[ -n "$ARTIFACT_ELECTRON" ]]; then
  echo "      - ${ARTIFACT_ELECTRON}"
fi
echo ""
echo "    View: gh release view ${TAG}"

# Cleanup
rm -rf "$DIST_DIR"
echo "==> Done."
