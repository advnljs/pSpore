#!/usr/bin/env bash
# Overlay upgrade: copy resources/app.asar from this archive onto an existing
# pSpore desktop install without replacing Chromium/Electron.
set -euo pipefail

HERE="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ASAR="$HERE/resources/app.asar"
TARGET="${1:-}"

if [[ ! -f "$ASAR" ]]; then
  echo "未找到 resources/app.asar" >&2
  echo "请先解压覆盖升级包。" >&2
  exit 1
fi

if [[ -z "$TARGET" ]]; then
  if [[ -x "$HERE/pspore-desktop" ]]; then
    TARGET="$HERE"
  elif [[ -x "$PWD/pspore-desktop" ]]; then
    TARGET="$PWD"
  else
    echo "用法: $0 <已安装目录>" >&2
    echo "将本压缩包解压到安装目录（与 pspore-desktop 同一层），或传入安装目录路径。" >&2
    exit 1
  fi
fi

if [[ ! -f "$TARGET/pspore-desktop" ]]; then
  echo "目标目录不是 pSpore 安装目录（缺少 pspore-desktop）: $TARGET" >&2
  exit 1
fi

mkdir -p "$TARGET/resources"
cp -f "$ASAR" "$TARGET/resources/app.asar"
chmod 644 "$TARGET/resources/app.asar"
echo "已覆盖升级: $TARGET/resources/app.asar"
