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

Produces a standalone Linux x86_64 CLI binary via Node SEA and uploads
it to a GitHub release. No Node.js runtime required by end users.

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

echo "==> Building release ${TAG}"

# ─── Install & Build ───────────────────────────────────────────────
echo "--- npm ci"
npm ci 2>/dev/null || npm install

echo "--- npm run build"
npm run build

# ─── Prepare output dir ───────────────────────────────────────────
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# ─── Standalone CLI binary ───────────────────────────────────────
echo "--- Building standalone CLI release binary"
bash "$REPO_ROOT/scripts/build-cli-binary.sh" "$VERSION"

# ─── Electron Desktop zips ────────────────────────────────────────
FULL_ZIP_NAME="pspore-desktop-${VERSION}-linux-x64.zip"
OVERLAY_ZIP_NAME="pspore-desktop-${VERSION}-linux-x64-overlay.zip"
FULL_ZIP_PATH=""
OVERLAY_ZIP_PATH=""
if [[ -d "dist/desktop" ]]; then
  echo "--- Building Electron desktop zips"
  bash "$REPO_ROOT/scripts/package-desktop.sh" "$VERSION"
  if [[ -f "$DIST_DIR/$FULL_ZIP_NAME" ]]; then
    FULL_ZIP_PATH="$DIST_DIR/$FULL_ZIP_NAME"
  fi
  if [[ -f "$DIST_DIR/$OVERLAY_ZIP_NAME" ]]; then
    OVERLAY_ZIP_PATH="$DIST_DIR/$OVERLAY_ZIP_NAME"
  fi
fi

# ─── Tag & Release ────────────────────────────────────────────────
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "--- Tag ${TAG} already exists"
else
  echo "--- Tagging ${TAG}"
  git tag -a "$TAG" -m "Release ${TAG}"
fi
git push origin "$TAG"

UPLOAD_FILES=("$DIST_DIR/$BINARY_NAME")
if [[ -n "$FULL_ZIP_PATH" ]]; then
  UPLOAD_FILES+=("$FULL_ZIP_PATH")
fi
if [[ -n "$FULL_ZIP_PATH" && -f "$FULL_ZIP_PATH.sha256" ]]; then
  UPLOAD_FILES+=("$FULL_ZIP_PATH.sha256")
fi
if [[ -n "$OVERLAY_ZIP_PATH" ]]; then
  UPLOAD_FILES+=("$OVERLAY_ZIP_PATH")
fi
if [[ -n "$OVERLAY_ZIP_PATH" && -f "$OVERLAY_ZIP_PATH.sha256" ]]; then
  UPLOAD_FILES+=("$OVERLAY_ZIP_PATH.sha256")
fi

echo "--- Creating GitHub release"
  if gh release view "$TAG" >/dev/null 2>&1; then
    echo "Release ${TAG} already exists; uploading artifacts"
    gh release upload "$TAG" "${UPLOAD_FILES[@]}" --clobber
    echo ""
  echo "==> Release ${TAG} updated!"
  echo "    Artifacts:"
  echo "      - $BINARY_NAME (standalone CLI)"
  if [[ -n "$FULL_ZIP_PATH" ]]; then
    echo "      - $FULL_ZIP_NAME (desktop zip with shortcut script)"
  fi
  if [[ -n "$OVERLAY_ZIP_PATH" ]]; then
    echo "      - $OVERLAY_ZIP_NAME (overlay upgrade without Chromium)"
  fi
  echo "    View: gh release view ${TAG}"
  echo "==> Done."
  exit 0
fi

RELEASE_NOTES="## pSpore ${TAG}

### Downloads

| File | Description |
|------|-------------|
| \`${BINARY_NAME}\` | Standalone CLI binary (no Node.js required) |
| \`${FULL_ZIP_NAME}\` | Desktop GUI zip (includes Chromium; run 创建桌面快捷方式.sh) |
| \`${OVERLAY_ZIP_NAME}\` | Overlay upgrade zip (app.asar only, no Chromium) |

### CLI Binary

\`\`\`bash
chmod +x ${BINARY_NAME}
./${BINARY_NAME} version
sudo mv ${BINARY_NAME} /usr/local/bin/pspore
pspore init && pspore doctor
\`\`\`

### Desktop App (full zip)

\`\`\`bash
unzip ${FULL_ZIP_NAME}
cd pspore-desktop-${VERSION}-linux-x64
./创建桌面快捷方式.sh
\`\`\`

### Overlay upgrade (no Chromium)

\`\`\`bash
unzip ${OVERLAY_ZIP_NAME} -d /path/to/pspore-desktop-${VERSION}-linux-x64
# or: ./覆盖升级.sh /path/to/existing-install
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

gh release create "${GH_ARGS[@]}" "${UPLOAD_FILES[@]}"

echo ""
echo "==> Release ${TAG} published!"
echo "    Artifacts:"
echo "      - $BINARY_NAME (standalone CLI)"
if [[ -n "$FULL_ZIP_PATH" ]]; then
  echo "      - $FULL_ZIP_NAME (desktop zip with shortcut script)"
fi
if [[ -n "$OVERLAY_ZIP_PATH" ]]; then
  echo "      - $OVERLAY_ZIP_NAME (overlay upgrade without Chromium)"
fi
echo "    View: gh release view ${TAG}"
echo "==> Done."
