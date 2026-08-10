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

if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(String(+process.versions.node.split(".")[0]>=24))')" != "1" ]]; then
  echo "Error: node >= 24 is required"
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

# ─── Bundle with esbuild ──────────────────────────────────────────
echo "--- Bundling CLI with esbuild (CJS for SEA)"
npx --yes esbuild dist/cli/main.js \
  --bundle \
  --platform=node \
  --target=node24 \
  --format=cjs \
  --outfile="$DIST_DIR/pspore-bundle.cjs" \
  --external:electron \
  --banner:js="const _orig_fUTP=require('url').fileURLToPath;require('url').fileURLToPath=function(p){if(p==null)return process.execPath;return _orig_fUTP(p)};"

# Patch empty import_meta objects so import_meta.url works in SEA context
echo "--- Patching import_meta for SEA compatibility"
sed -i 's/var import_meta\([0-9]*\) = {};/var import_meta\1 = {url:require("url").pathToFileURL(process.execPath).href,resolve:function(s){return new(require("url").URL)(s,this.url).href}};/g' \
  "$DIST_DIR/pspore-bundle.cjs"

# ─── Generate SEA blob ────────────────────────────────────────────
echo "--- Generating Node SEA blob"
cat > "$DIST_DIR/sea-config.json" <<SEACFG
{
  "main": "$DIST_DIR/pspore-bundle.cjs",
  "output": "$DIST_DIR/pspore.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": true
}
SEACFG

node --experimental-sea-config "$DIST_DIR/sea-config.json"

# ─── Inject into node binary ─────────────────────────────────────
echo "--- Injecting SEA blob into node binary"
cp "$(command -v node)" "$DIST_DIR/$BINARY_NAME"
chmod 755 "$DIST_DIR/$BINARY_NAME"

npx --yes postject "$DIST_DIR/$BINARY_NAME" NODE_SEA_BLOB "$DIST_DIR/pspore.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

# ─── Verify binary ───────────────────────────────────────────────
echo "--- Verifying binary"
VOUT=$("$DIST_DIR/$BINARY_NAME" version 2>&1) || {
  echo "Error: binary failed to run 'version' command"
  echo "$VOUT"
  exit 1
}
echo "    $VOUT"

HOUT=$("$DIST_DIR/$BINARY_NAME" --help 2>&1) || {
  echo "Error: binary failed to run '--help'"
  exit 1
}
echo "    --help: OK ($(echo "$HOUT" | wc -l) lines)"

echo "--- Binary verified: $BINARY_NAME ($(du -h "$DIST_DIR/$BINARY_NAME" | cut -f1))"

# ─── Tag & Release ────────────────────────────────────────────────
echo "--- Tagging ${TAG}"
git tag -a "$TAG" -m "Release ${TAG}"
git push origin "$TAG"

echo "--- Creating GitHub release"
RELEASE_NOTES="## pSpore ${TAG}

Standalone Linux x86_64 binary. No Node.js runtime required.

### Download & Run

\`\`\`bash
chmod +x ${BINARY_NAME}
./${BINARY_NAME} version
sudo mv ${BINARY_NAME} /usr/local/bin/pspore
pspore init && pspore doctor
\`\`\`

### Platform

- Linux x86_64 (single ELF binary)
"

GH_ARGS=(
  "$TAG"
  --title "pSpore ${TAG}"
  --notes "$RELEASE_NOTES"
)

if [[ "$PRERELEASE" == "--prerelease" ]]; then
  GH_ARGS+=(--prerelease)
fi

gh release create "${GH_ARGS[@]}" "$DIST_DIR/$BINARY_NAME"

# ─── Cleanup intermediates ────────────────────────────────────────
rm -f "$DIST_DIR/pspore-bundle.cjs" "$DIST_DIR/pspore.blob" "$DIST_DIR/sea-config.json"

echo ""
echo "==> Release ${TAG} published!"
echo "    Binary: $DIST_DIR/$BINARY_NAME"
echo "    View:   gh release view ${TAG}"
echo "==> Done."
