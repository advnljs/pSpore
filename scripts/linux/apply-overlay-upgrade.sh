#!/usr/bin/env bash
# Replace every application file except the fixed Electron/Chromium runtime. The
# target runtime is used as Node for compatibility and integrity checks, so the
# updater has no dependency on a separately installed Node.js.
#
# Progress is reported as `[ NN%] message` lines so 图形界面升级.sh can drive a
# progress bar from the same script the terminal uses.
set -euo pipefail
umask 077

HERE="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PAYLOAD_ROOT="$HERE/payload"
PAYLOAD_RESOURCES="$PAYLOAD_ROOT/resources"
MANIFEST="$HERE/overlay-manifest.json"
TARGET="${1:-}"
STAGE=""
BACKUP=""
LOCK_DIR=""
LOCK_HELD=0
SWAP_STARTED=0
COMPLETED=0
declare -a INSTALLED_NAMES=()
declare -a BACKED_UP_NAMES=()

fail() {
  echo "升级失败：$1" >&2
  exit 1
}

progress() {
  printf '[%3d%%] %s\n' "$1" "$2"
}

if [[ ! -f "$MANIFEST" || ! -f "$PAYLOAD_RESOURCES/app.asar" ]]; then
  fail "升级包不完整；请重新解压，确认 overlay-manifest.json 和 payload/resources/app.asar 存在。"
fi

if [[ -z "$TARGET" ]]; then
  if [[ -x "$HERE/pspore-desktop" ]]; then
    TARGET="$HERE"
  elif [[ -x "$PWD/pspore-desktop" ]]; then
    TARGET="$PWD"
  else
    echo "用法: $0 <已有完整安装目录>" >&2
    echo "也可以把升级包解压到安装目录后直接运行本脚本。" >&2
    exit 1
  fi
fi
if [[ ! -d "$TARGET" ]]; then
  fail "目标目录不存在: $TARGET"
fi
TARGET="$(cd "$TARGET" && pwd -P)"
if [[ "$TARGET" == *$'\n'* || "$TARGET" == *$'\r'* ]]; then
  fail "目标目录不能包含换行符。"
fi

EXEC="$TARGET/pspore-desktop"
RESOURCES="$TARGET/resources"
if [[ ! -x "$EXEC" || ! -f "$RESOURCES/app.asar" ]]; then
  fail "目标不是完整的 pSpore 安装目录（缺少可执行文件或 resources/app.asar）: $TARGET"
fi
# The payload replaces application files only; shipping a runtime file would
# swap Chromium underneath a process that is expected to keep working.
if [[ -e "$PAYLOAD_ROOT/pspore-desktop" || -e "$PAYLOAD_ROOT/locales" ]]; then
  fail "升级包不应包含 Electron/Chromium 运行时文件；请重新下载 overlay 包。"
fi

progress 5 "正在读取升级包信息…"

electron_node() {
  env ELECTRON_RUN_AS_NODE=1 "$EXEC" "$@"
}

manifest_values="$(electron_node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const fields = [
    value.schemaVersion,
    value.appVersion,
    value.electronVersion,
    value.platform,
    value.arch,
    value.payloadSha256,
  ];
  if (fields.some((field) => typeof field !== "string" && typeof field !== "number")) {
    throw new Error("overlay manifest fields are missing");
  }
  process.stdout.write(fields.map(String).join("\n"));
' "$MANIFEST")" || fail "无法读取 overlay manifest；现有 Electron 运行时可能已损坏。"
mapfile -t MANIFEST_FIELDS <<< "$manifest_values"
if (( ${#MANIFEST_FIELDS[@]} != 6 )); then
  fail "overlay manifest 字段数量不正确。"
fi
SCHEMA_VERSION="${MANIFEST_FIELDS[0]}"
APP_VERSION="${MANIFEST_FIELDS[1]}"
ELECTRON_VERSION="${MANIFEST_FIELDS[2]}"
PLATFORM="${MANIFEST_FIELDS[3]}"
ARCH="${MANIFEST_FIELDS[4]}"
EXPECTED_PAYLOAD_SHA256="${MANIFEST_FIELDS[5]}"

if [[ "$SCHEMA_VERSION" != "1" ]]; then
  fail "不支持的升级包格式版本: $SCHEMA_VERSION"
fi
if [[ ! "$APP_VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$ ]]; then
  fail "升级包应用版本无效。"
fi
if [[ ! "$ELECTRON_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "升级包 Electron 版本无效。"
fi
if [[ "$PLATFORM" != "linux" || ( "$ARCH" != "x64" && "$ARCH" != "arm64" ) ]]; then
  fail "升级包平台无效（仅支持 linux/x64 或 linux/arm64，实际 $PLATFORM/$ARCH）。"
fi
if [[ ! "$EXPECTED_PAYLOAD_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  fail "升级包 payload SHA-256 无效。"
fi

progress 15 "正在校验运行时兼容性…"

runtime_values="$(electron_node -e '
  process.stdout.write([
    process.versions.electron || "",
    process.platform,
    process.arch,
  ].join("\n"));
')" || fail "无法启动现有 Electron 运行时。"
mapfile -t RUNTIME_FIELDS <<< "$runtime_values"
if (( ${#RUNTIME_FIELDS[@]} != 3 )); then
  fail "无法识别现有 Electron 运行时。"
fi
if [[ "${RUNTIME_FIELDS[0]}" != "$ELECTRON_VERSION" ]]; then
  fail "Electron 运行时不兼容：升级包需要 $ELECTRON_VERSION，现有版本为 ${RUNTIME_FIELDS[0]:-unknown}。请改用全量安装包。"
fi
if [[ "${RUNTIME_FIELDS[1]}" != "$PLATFORM" || "${RUNTIME_FIELDS[2]}" != "$ARCH" ]]; then
  fail "运行平台不兼容：升级包为 $PLATFORM/$ARCH，现有安装为 ${RUNTIME_FIELDS[1]}/${RUNTIME_FIELDS[2]}。"
fi

progress 30 "正在校验升级包完整性…"

actual_payload_sha256="$(electron_node -e '
  process.noAsar = true;
  const { createHash } = require("node:crypto");
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.resolve(process.argv[1]);
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
  process.stdout.write(hash.digest("hex"));
' "$PAYLOAD_ROOT")" || fail "无法计算升级 payload 的 SHA-256。"
if [[ "$actual_payload_sha256" != "$EXPECTED_PAYLOAD_SHA256" ]]; then
  fail "升级 payload 校验失败；期望 $EXPECTED_PAYLOAD_SHA256，实际 $actual_payload_sha256。请重新下载升级包。"
fi

installed_version="unknown"
if current_output="$(electron_node "$RESOURCES/app.asar/dist/cli/main.js" version 2>/dev/null)"; then
  installed_version="$current_output"
fi

LOCK_DIR="$TARGET/.pspore-overlay.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  fail "另一个升级进程正在运行，或上次异常中断留下了锁: $LOCK_DIR"
fi
LOCK_HELD=1

rollback_swap() {
  local name
  for name in "${INSTALLED_NAMES[@]}"; do
    if [[ -e "$TARGET/$name" || -L "$TARGET/$name" ]]; then
      mv "$TARGET/$name" "$BACKUP/failed-$name" 2>/dev/null || true
    fi
  done
  for name in "${BACKED_UP_NAMES[@]}"; do
    if [[ -e "$BACKUP/$name" || -L "$BACKUP/$name" ]]; then
      mv "$BACKUP/$name" "$TARGET/$name" 2>/dev/null || true
    fi
  done
  echo "已回滚到升级前版本；失败文件保留在: $BACKUP" >&2
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if (( status != 0 && SWAP_STARTED == 1 && COMPLETED == 0 )); then
    rollback_swap
  fi
  if [[ -n "$STAGE" && -d "$STAGE" ]]; then
    case "$STAGE" in
      "$TARGET"/.pspore-overlay-new.*) rm -rf -- "$STAGE" ;;
    esac
  fi
  if (( LOCK_HELD == 1 )) && [[ -d "$LOCK_DIR" ]]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

progress 45 "正在准备新版本文件…"

# Staging next to the install keeps the swap on one filesystem, so every
# replacement is an atomic rename rather than a partial copy.
STAGE="$(mktemp -d "$TARGET/.pspore-overlay-new.XXXXXX")"
cp -a "$PAYLOAD_ROOT"/. "$STAGE"/
new_output="$(electron_node "$STAGE/resources/app.asar/dist/cli/main.js" version 2>&1)" \
  || fail "新应用 payload 自检失败: $new_output"
if [[ "$new_output" != "pSpore $APP_VERSION" && "$new_output" != "pSpore $APP_VERSION "* ]]; then
  fail "新应用版本自检不匹配；期望 pSpore $APP_VERSION，实际: $new_output"
fi

progress 65 "正在替换应用文件…"

BACKUP="$TARGET/.pspore-backup-$(date +%Y%m%dT%H%M%S)-$$"
mkdir "$BACKUP"
SWAP_STARTED=1
while IFS= read -r -d '' staged_item; do
  name="$(basename -- "$staged_item")"
  if [[ -e "$TARGET/$name" || -L "$TARGET/$name" ]]; then
    mv "$TARGET/$name" "$BACKUP/$name"
    BACKED_UP_NAMES+=("$name")
  fi
  mv "$staged_item" "$TARGET/$name"
  INSTALLED_NAMES+=("$name")
done < <(find "$STAGE" -mindepth 1 -maxdepth 1 -print0 | sort -z)

# A zip round-trip can lose the executable bit on the helper scripts.
for script in "$TARGET"/*.sh; do
  [[ -f "$script" ]] && chmod 0755 "$script" 2>/dev/null || true
done

if [[ -f "$RESOURCES/native/pspore-startup" ]]; then
  chmod 0755 "$RESOURCES/native/pspore-startup" || fail "无法设置原生启动器的执行权限"
fi

progress 80 "正在校验升级结果…"

verified_output="$(electron_node "$RESOURCES/app.asar/dist/cli/main.js" version 2>&1)" \
  || fail "升级后的应用自检失败: $verified_output"
if [[ "$verified_output" != "pSpore $APP_VERSION" && "$verified_output" != "pSpore $APP_VERSION "* ]]; then
  fail "升级后的应用版本不匹配；实际: $verified_output"
fi
COMPLETED=1

# The desktop entry points at a stable launcher that reads this install record,
# so an existing shortcut has to be re-pointed at whichever directory was just
# upgraded. Without it a user who upgrades one copy keeps launching another.
refresh_desktop_shortcut() {
  if [[ "${PSPORE_OVERLAY_SKIP_SHORTCUT_REFRESH:-0}" == "1" ]]; then
    return
  fi
  local data_home app_data_dir install_file installer applications_dir
  data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
  app_data_dir="$data_home/pspore"
  install_file="$app_data_dir/install-dir"
  applications_dir="$data_home/applications"
  installer="$TARGET/创建桌面快捷方式.sh"
  # Only refresh what the user already has; never create a shortcut uninvited.
  if [[ ! -f "$install_file" && ! -f "$applications_dir/pSpore.desktop" ]]; then
    echo "未发现已安装的桌面快捷方式；如需创建请运行安装目录中的「创建桌面快捷方式.sh」。"
    return
  fi
  if [[ ! -x "$installer" ]]; then
    echo "警告：升级包未提供「创建桌面快捷方式.sh」，请手动确认桌面快捷方式指向 $TARGET。" >&2
    return
  fi
  if PSPORE_SHORTCUT_SKIP_NOTIFY=1 bash "$installer" < /dev/null > /dev/null 2>&1; then
    echo "已将桌面快捷方式指向本次升级的安装目录: $TARGET"
  else
    echo "警告：无法刷新桌面快捷方式；请手动运行 $installer。" >&2
  fi
}

restart_matching_services() {
  if [[ "${PSPORE_OVERLAY_SKIP_SERVICE_RESTART:-0}" == "1" ]] || ! command -v systemctl >/dev/null 2>&1; then
    return
  fi
  local unit_dir unit_path unit_name unit_exec restarted=0
  unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  unit_exec="${EXEC//%/%%}"
  unit_exec="${unit_exec//\\/\\\\}"
  unit_exec="${unit_exec//\"/\\\"}"
  [[ -d "$unit_dir" ]] || return
  for unit_path in "$unit_dir"/pspore*.service; do
    [[ -f "$unit_path" ]] || continue
    if grep -Fq "$unit_exec" "$unit_path"; then
      unit_name="$(basename -- "$unit_path")"
      if systemctl --user restart "$unit_name"; then
        echo "已重启后台服务: $unit_name"
        restarted=1
      else
        echo "警告：无法重启后台服务 $unit_name；请重新打开 pSpore 或手动执行 systemctl --user restart $unit_name。" >&2
      fi
    fi
  done
  if (( restarted == 0 )); then
    echo "未发现绑定此安装目录的运行中 systemd 服务；下次启动客户端时会自动启用。"
  fi
}

progress 90 "正在刷新快捷方式与后台服务…"
refresh_desktop_shortcut
restart_matching_services
rmdir "$STAGE" 2>/dev/null || true
STAGE=""
rmdir "$LOCK_DIR" 2>/dev/null || true
LOCK_HELD=0

progress 100 "升级完成"
echo "升级成功："
echo "  原版本: $installed_version"
echo "  当前版本: $verified_output"
echo "  Electron 运行时: $ELECTRON_VERSION ($PLATFORM/$ARCH，未替换 Chromium)"
echo "  已替换应用文件: ${INSTALLED_NAMES[*]}"
echo "  可回滚备份: $BACKUP"
echo "  个人配置 (~/.pspore) 未改动；新增配置项会在下次启动时按默认值补齐。"
echo "如桌面窗口仍在运行，请关闭并重新打开以加载全部新代码。"
