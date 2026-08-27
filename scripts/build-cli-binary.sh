#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

DIST_DIR="$REPO_ROOT/release-dist"
VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  VERSION="$(node -p "require('./package.json').version")"
fi
BINARY_NAME="pspore-${VERSION}-linux-x64"

if ! command -v node >/dev/null; then
  echo "Error: node >= 24 is required"
  exit 1
fi
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 24 ]]; then
  echo "Error: node >= 24 is required (found $(node -v))"
  exit 1
fi
if [[ ! -f "$REPO_ROOT/dist/cli/main.js" ]]; then
  echo "Error: dist/cli/main.js is missing. Run 'npm run build' first."
  exit 1
fi

mkdir -p "$DIST_DIR"
rm -f "$DIST_DIR/$BINARY_NAME" \
  "$DIST_DIR/$BINARY_NAME.sha256" \
  "$DIST_DIR/pspore-bundle.cjs" "$DIST_DIR/pspore.blob" "$DIST_DIR/sea-config.json"

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

(
  cd "$DIST_DIR"
  sha256sum "$BINARY_NAME" > "$BINARY_NAME.sha256"
)

rm -f "$DIST_DIR/pspore-bundle.cjs" "$DIST_DIR/pspore.blob" "$DIST_DIR/sea-config.json"

echo "--- Binary ready: $DIST_DIR/$BINARY_NAME ($(du -h "$DIST_DIR/$BINARY_NAME" | cut -f1))"
