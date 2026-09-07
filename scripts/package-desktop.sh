#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

EXPECTED_VERSION="${1:-}"
REQUESTED_ARCH="${2:-}"
ELECTRON_BUILDER_VERSION="${ELECTRON_BUILDER_VERSION:-26.15.3}"
DIST_DIR="$REPO_ROOT/release-dist"

if ! command -v node >/dev/null; then
  echo "Error: node >= 24 is required"
  exit 1
fi
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 24 ]]; then
  echo "Error: node >= 24 is required (found $(node -v))"
  exit 1
fi
NODE_ARCH="$(node -p "process.arch")"
ARCH="${REQUESTED_ARCH:-$NODE_ARCH}"
case "$ARCH" in
  x64|arm64) ;;
  *)
    echo "Error: unsupported Linux architecture ${ARCH}; expected x64 or arm64"
    exit 1
    ;;
esac
if [[ "$NODE_ARCH" != "$ARCH" ]]; then
  echo "Error: desktop packaging requires a native ${ARCH} runner (current architecture: ${NODE_ARCH})"
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
ELECTRON_VERSION="$(node -p "require('./package.json').devDependencies.electron")"
FULL_NAME="pspore-desktop-${VERSION}-linux-${ARCH}"
OVERLAY_NAME="pspore-desktop-${VERSION}-linux-${ARCH}-overlay"
FULL_ZIP="$DIST_DIR/${FULL_NAME}.zip"
OVERLAY_ZIP="$DIST_DIR/${OVERLAY_NAME}.zip"
if [[ "$ARCH" == "x64" ]]; then
  UNPACKED_DIR="$DIST_DIR/electron-out/linux-unpacked"
else
  UNPACKED_DIR="$DIST_DIR/electron-out/linux-${ARCH}-unpacked"
fi

if [[ -n "$EXPECTED_VERSION" && "$EXPECTED_VERSION" != "$VERSION" ]]; then
  echo "Error: package.json version ${VERSION} does not match expected ${EXPECTED_VERSION}"
  exit 1
fi
if [[ ! "$ELECTRON_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: devDependencies.electron must be an exact version for overlay compatibility (found ${ELECTRON_VERSION})"
  exit 1
fi

echo "==> Packaging desktop zip ${FULL_NAME}.zip, overlay ${OVERLAY_NAME}.zip and CLI binary"

# Native helpers for bundled skills. Best effort on purpose: until the upstream
# release exists the skill ships without its binary and pSpore reports the
# feature as unavailable, which is better than blocking the whole release.
echo "--- fetching bundled skill binaries (${ARCH})"
if bash "$REPO_ROOT/scripts/fetch-bundled-binaries.sh" "$ARCH"; then
  echo "--- bundled skill binaries ready"
else
  echo "WARNING: bundled skill binaries unavailable; skills that need them will report unavailable at runtime" >&2
fi

echo "--- npm run build"
npm run build

mkdir -p "$DIST_DIR"
rm -rf "$DIST_DIR/electron-out" "$DIST_DIR/staging-full" "$DIST_DIR/staging-overlay"
rm -f "$FULL_ZIP" "$FULL_ZIP.sha256" "$OVERLAY_ZIP" "$OVERLAY_ZIP.sha256"

echo "--- electron-builder@${ELECTRON_BUILDER_VERSION} linux dir"
npx --yes "electron-builder@${ELECTRON_BUILDER_VERSION}" \
  --linux dir \
  "--${ARCH}" \
  --publish never \
  --config electron-builder.yml

if [[ ! -x "$UNPACKED_DIR/pspore-desktop" ]]; then
  echo "Error: electron-builder did not produce ${UNPACKED_DIR#$DIST_DIR/}/pspore-desktop"
  echo "--- electron-out contents ---"
  ls -la "$DIST_DIR/electron-out" || true
  ls -la "$UNPACKED_DIR" || true
  exit 1
fi
if [[ ! -f "$UNPACKED_DIR/resources/app.asar" ]]; then
  echo "Error: unpacked app is missing resources/app.asar"
  exit 1
fi
BUILT_ELECTRON_VERSION="$(env ELECTRON_RUN_AS_NODE=1 "$UNPACKED_DIR/pspore-desktop" -p 'process.versions.electron')"
BUILT_ARCH="$(env ELECTRON_RUN_AS_NODE=1 "$UNPACKED_DIR/pspore-desktop" -p 'process.arch')"
if [[ "$BUILT_ELECTRON_VERSION" != "$ELECTRON_VERSION" || "$BUILT_ARCH" != "$ARCH" ]]; then
  echo "Error: built runtime ${BUILT_ELECTRON_VERSION}/${BUILT_ARCH} does not match overlay contract ${ELECTRON_VERSION}/${ARCH}"
  exit 1
fi
BUILT_APP_OUTPUT="$(env ELECTRON_RUN_AS_NODE=1 "$UNPACKED_DIR/pspore-desktop" "$UNPACKED_DIR/resources/app.asar/dist/cli/main.js" version)"
if [[ "$BUILT_APP_OUTPUT" != "pSpore $VERSION" && "$BUILT_APP_OUTPUT" != "pSpore $VERSION "* ]]; then
  echo "Error: built app version does not match package.json (${BUILT_APP_OUTPUT})"
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
请使用较小的 overlay 压缩包 pspore-desktop-${VERSION}-linux-${ARCH}-overlay.zip。
解压后双击其中的「图形界面升级.sh」选择本安装目录并查看进度条，
或在终端运行「覆盖升级.sh /path/to/安装目录」。升级脚本会校验
Electron/架构与 payload，保留可回滚备份，并重启匹配的后台服务。
overlay 含 Chromium/Electron 运行时之外的全部应用文件，升级时整体替换。
EOF

# The overlay carries everything except the fixed Electron/Chromium runtime, and
# the updater replaces all of it wholesale. Listing only the runtime keeps new
# top-level application files shipping automatically instead of being forgotten.
ELECTRON_RUNTIME_ENTRIES=(
  pspore-desktop
  chrome-sandbox
  chrome_crashpad_handler
  chrome_100_percent.pak
  chrome_200_percent.pak
  resources.pak
  icudtl.dat
  snapshot_blob.bin
  v8_context_snapshot.bin
  vk_swiftshader_icd.json
  libEGL.so
  libGLESv2.so
  libffmpeg.so
  libvk_swiftshader.so
  libvulkan.so.1
  locales
  LICENSE.electron.txt
  LICENSES.chromium.html
)

STAGE_OVERLAY="$DIST_DIR/staging-overlay"
mkdir -p "$STAGE_OVERLAY/payload"
while IFS= read -r -d '' entry; do
  name="$(basename -- "$entry")"
  skip=0
  for runtime in "${ELECTRON_RUNTIME_ENTRIES[@]}"; do
    if [[ "$name" == "$runtime" ]]; then
      skip=1
      break
    fi
  done
  if (( skip == 0 )); then
    cp -a "$entry" "$STAGE_OVERLAY/payload/$name"
  fi
done < <(find "$STAGE_FULL" -mindepth 1 -maxdepth 1 -print0 | sort -z)

if [[ ! -f "$STAGE_OVERLAY/payload/resources/app.asar" ]]; then
  echo "Error: overlay payload is missing resources/app.asar"
  exit 1
fi
if [[ ! -f "$STAGE_OVERLAY/payload/创建桌面快捷方式.sh" ]]; then
  echo "Error: overlay payload must ship the shortcut installer so upgrades can re-point existing shortcuts"
  exit 1
fi
for runtime in "${ELECTRON_RUNTIME_ENTRIES[@]}"; do
  if [[ -e "$STAGE_OVERLAY/payload/$runtime" ]]; then
    echo "Error: overlay payload must not contain the Electron runtime entry ${runtime}"
    exit 1
  fi
done
# The loop above shares the exclusion list with the copy, so it can only catch a
# copy bug — never a stale list. This allowlist is the independent check: if
# Electron ever ships a new top-level file, packaging fails here instead of
# silently pushing a runtime file into an overlay that promises not to touch it.
while IFS= read -r -d '' entry; do
  name="$(basename -- "$entry")"
  case "$name" in
    resources|*.sh|*.txt) ;;
    *)
      echo "Error: unexpected top-level overlay payload entry '${name}'."
      echo "       Add it to ELECTRON_RUNTIME_ENTRIES if it belongs to the Chromium runtime,"
      echo "       or to this allowlist if it is genuinely part of the application payload."
      exit 1
      ;;
  esac
done < <(find "$STAGE_OVERLAY/payload" -mindepth 1 -maxdepth 1 -print0)
# No executable image belongs at the payload root; native .node files under
# resources/app.asar.unpacked are legitimate and deliberately not covered here.
if find "$STAGE_OVERLAY/payload" -maxdepth 1 -type f -exec file {} + | grep -E "ELF|executable"; then
  echo "Error: overlay payload root must not contain executable images"
  exit 1
fi
echo "--- overlay payload entries: $(find "$STAGE_OVERLAY/payload" -mindepth 1 -maxdepth 1 -printf '%f ')"
node - "$STAGE_OVERLAY/payload" "$VERSION" "$BUILT_ELECTRON_VERSION" "$BUILT_ARCH" <<'NODE' > "$STAGE_OVERLAY/overlay-manifest.json"
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [rootArgument, appVersion, electronVersion, arch] = process.argv.slice(2);
const root = path.resolve(rootArgument);
const files = [];
function walk(directory, prefix = "") {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, relative);
    else if (entry.isFile()) files.push([relative, absolute]);
    else throw new Error(`unsupported payload entry: ${relative}`);
  }
}
walk(root);
const hash = createHash("sha256");
for (const [relative, absolute] of files) {
  const data = fs.readFileSync(absolute);
  hash.update(relative, "utf8");
  hash.update("\0");
  hash.update(String(data.length), "utf8");
  hash.update("\0");
  hash.update(data);
  hash.update("\0");
}
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  appVersion,
  electronVersion,
  platform: "linux",
  arch,
  payloadSha256: hash.digest("hex"),
}, null, 2)}\n`);
NODE
install -m 0755 "$REPO_ROOT/scripts/linux/apply-overlay-upgrade.sh" "$STAGE_OVERLAY/覆盖升级.sh"
install -m 0755 "$REPO_ROOT/scripts/linux/overlay-upgrade-gui.sh" "$STAGE_OVERLAY/图形界面升级.sh"
cat > "$STAGE_OVERLAY/覆盖升级说明.txt" <<EOF
pSpore Desktop ${VERSION} overlay

本压缩包包含 Chromium/Electron 固定运行时之外的全部应用文件
（resources/ 下的 app.asar 与 unpacked 内容、创建桌面快捷方式.sh、安装说明等），
升级时整体替换；Chromium 保持原样不动。

覆盖升级（图形界面）
1. 先已有一次完整安装（全量 zip）
2. 关闭当前桌面窗口并解压本升级包
3. 双击「图形界面升级.sh」，选择已安装目录，等待进度条完成

覆盖升级（终端）
  ./覆盖升级.sh /path/to/已有安装目录

脚本只接受 Linux ${ARCH} 且 Electron ${BUILT_ELECTRON_VERSION} 完全相同的安装，自动校验
payload、自检新版本、保留 .pspore-backup-* 回滚备份，把已有桌面快捷方式重新
指向本次升级的安装目录，并重启匹配的 systemd 用户服务。
运行时不匹配时请下载全量 zip。

个人数据与配置（~/.pspore）不会被覆盖：已有配置保持原值，新版本新增的配置项
会在下次启动时按默认值增量补齐。

能否从某个旧版本覆盖升级由目标安装的 Electron、平台和架构决定；脚本会在
写入前完成判定，不兼容时不会改动现有安装。
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

echo "--- keeping the unpacked runnable app dir in release-dist"
# Every packaging leaves a locally runnable directory identical to the
# full-release zip content, so the latest build is always ready to start.
rm -rf "$DIST_DIR/$FULL_NAME"
cp -a "$STAGE_FULL" "$DIST_DIR/"

rm -rf "$DIST_DIR/electron-out" "$DIST_DIR/staging-full" "$DIST_DIR/staging-overlay"

echo "--- Building standalone CLI release binary"
bash "$REPO_ROOT/scripts/build-cli-binary.sh" "$VERSION" "$ARCH"

echo "==> Full package: $FULL_ZIP ($(du -h "$FULL_ZIP" | cut -f1))"
echo "==> Overlay package: $OVERLAY_ZIP ($(du -h "$OVERLAY_ZIP" | cut -f1))"
echo "==> Runnable app dir: $DIST_DIR/$FULL_NAME"
echo "==> CLI binary: $DIST_DIR/pspore-${VERSION}-linux-${ARCH}"
echo "==> CLI checksum: $DIST_DIR/pspore-${VERSION}-linux-${ARCH}.sha256"
