#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

EXPECTED_VERSION="${1:-}"
ELECTRON_BUILDER_VERSION="${ELECTRON_BUILDER_VERSION:-26.15.3}"
DIST_DIR="$REPO_ROOT/release-dist"
VERSION="$(node -p "require('./package.json').version")"
FULL_NAME="pspore-desktop-${VERSION}-linux-x64"
OVERLAY_NAME="pspore-desktop-${VERSION}-linux-x64-overlay"
FULL_ZIP="$DIST_DIR/${FULL_NAME}.zip"
OVERLAY_ZIP="$DIST_DIR/${OVERLAY_NAME}.zip"
UNPACKED_DIR="$DIST_DIR/electron-out/linux-unpacked"

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

echo "==> Packaging desktop zip ${FULL_NAME}.zip, overlay ${OVERLAY_NAME}.zip and CLI binary"
echo "--- npm run build"
npm run build

mkdir -p "$DIST_DIR"
rm -rf "$DIST_DIR/electron-out" "$DIST_DIR/staging-full" "$DIST_DIR/staging-overlay"
rm -f "$FULL_ZIP" "$FULL_ZIP.sha256" "$OVERLAY_ZIP" "$OVERLAY_ZIP.sha256"

echo "--- electron-builder@${ELECTRON_BUILDER_VERSION} linux dir"
npx --yes "electron-builder@${ELECTRON_BUILDER_VERSION}" \
  --linux dir \
  --x64 \
  --publish never \
  --config electron-builder.yml

if [[ ! -x "$UNPACKED_DIR/pspore-desktop" ]]; then
  echo "Error: electron-builder did not produce linux-unpacked/pspore-desktop"
  echo "--- electron-out contents ---"
  ls -la "$DIST_DIR/electron-out" || true
  ls -la "$UNPACKED_DIR" || true
  exit 1
fi
if [[ ! -f "$UNPACKED_DIR/resources/app.asar" ]]; then
  echo "Error: unpacked app is missing resources/app.asar"
  exit 1
fi

STAGE_FULL="$DIST_DIR/staging-full/$FULL_NAME"
mkdir -p "$STAGE_FULL"
cp -a "$UNPACKED_DIR"/. "$STAGE_FULL/"
install -m 0755 "$REPO_ROOT/scripts/linux/create-desktop-shortcut.sh" "$STAGE_FULL/创建桌面快捷方式.sh"
cat > "$STAGE_FULL/安装说明.txt" <<EOF
pSpore Desktop ${VERSION}

首次安装
1. 解压本压缩包到任意目录，例如 ~/Apps/${FULL_NAME}
2. 双击或运行「创建桌面快捷方式.sh」，会在桌面和应用菜单生成 pSpore 快捷方式
3. 之后可从桌面图标启动，无需再打开此目录

升级
请使用较小的 overlay 压缩包 pspore-desktop-${VERSION}-linux-x64-overlay.zip。
把它解压到本安装目录（与 pspore-desktop 同一层）覆盖 resources/app.asar，
或运行其中的「覆盖升级.sh」。overlay 不含 Chromium/Electron 运行时。
EOF

STAGE_OVERLAY="$DIST_DIR/staging-overlay"
mkdir -p "$STAGE_OVERLAY/resources"
cp -a "$UNPACKED_DIR/resources/app.asar" "$STAGE_OVERLAY/resources/app.asar"
install -m 0755 "$REPO_ROOT/scripts/linux/apply-overlay-upgrade.sh" "$STAGE_OVERLAY/覆盖升级.sh"
cat > "$STAGE_OVERLAY/覆盖升级说明.txt" <<EOF
pSpore Desktop ${VERSION} overlay

本压缩包只包含应用代码（resources/app.asar），不含 Chromium 等固定运行时。

覆盖升级
1. 先已有一次完整安装（全量 zip）
2. 将本压缩包解压到安装目录，与 pspore-desktop 可执行文件同一层
3. 或运行：./覆盖升级.sh /path/to/${FULL_NAME}

解压后 resources/app.asar 会被新版本替换，桌面快捷方式可继续使用。
EOF

echo "--- zipping full desktop package"
python3 - "$STAGE_FULL" "$FULL_ZIP" <<'PY'
import os, sys, zipfile
from pathlib import Path

source = Path(sys.argv[1])
dest = Path(sys.argv[2])
root = source.parent

with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(source.rglob("*")):
        if not path.is_file():
            continue
        info = zipfile.ZipInfo.from_file(path, path.relative_to(root).as_posix())
        info.external_attr = (path.stat().st_mode & 0xFFFF) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        with path.open("rb") as handle:
            archive.writestr(info, handle.read())
print(dest)
PY

echo "--- zipping overlay upgrade package"
python3 - "$STAGE_OVERLAY" "$OVERLAY_ZIP" <<'PY'
import os, sys, zipfile
from pathlib import Path

source = Path(sys.argv[1])
dest = Path(sys.argv[2])

with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(source.rglob("*")):
        if not path.is_file():
            continue
        info = zipfile.ZipInfo.from_file(path, path.relative_to(source).as_posix())
        info.external_attr = (path.stat().st_mode & 0xFFFF) << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        with path.open("rb") as handle:
            archive.writestr(info, handle.read())
print(dest)
PY

(
  cd "$DIST_DIR"
  sha256sum "$(basename "$FULL_ZIP")" | tee "$(basename "$FULL_ZIP").sha256"
  sha256sum "$(basename "$OVERLAY_ZIP")" | tee "$(basename "$OVERLAY_ZIP").sha256"
)

rm -rf "$DIST_DIR/electron-out" "$DIST_DIR/staging-full" "$DIST_DIR/staging-overlay"

echo "--- Building standalone CLI release binary"
bash "$REPO_ROOT/scripts/build-cli-binary.sh" "$VERSION"

echo "==> Full package: $FULL_ZIP ($(du -h "$FULL_ZIP" | cut -f1))"
echo "==> Overlay package: $OVERLAY_ZIP ($(du -h "$OVERLAY_ZIP" | cut -f1))"
echo "==> CLI binary: $DIST_DIR/pspore-${VERSION}-linux-x64"
