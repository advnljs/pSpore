#!/usr/bin/env bash
# Install a stable launcher, then point both Desktop Entry files at it. The
# launcher keeps working across in-place overlay upgrades and records startup
# failures in an XDG state log. Desktop menus that support actions can open it.
set -euo pipefail
umask 077

APP_DIR="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
EXEC="$APP_DIR/pspore-desktop"
APP_NAME="pSpore"
DESKTOP_FILENAME="pSpore.desktop"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
APP_DATA_DIR="$DATA_HOME/pspore"
LAUNCHER_DIR="$APP_DATA_DIR/bin"
LAUNCHER="$LAUNCHER_DIR/pspore-desktop-launcher"
INSTALL_FILE="$APP_DATA_DIR/install-dir"
LOG_FILE="$STATE_HOME/pspore/desktop-launcher.log"

fail() {
  echo "$1" >&2
  if [[ -t 0 ]]; then
    read -r -p "按 Enter 关闭…" _ || true
  fi
  exit 1
}

if [[ ! -f "$EXEC" ]]; then
  fail "未找到可执行文件: $EXEC"
fi
if [[ "$APP_DIR" == *$'\n'* || "$APP_DIR" == *$'\r'* ]]; then
  fail "安装目录不能包含换行符。"
fi
chmod +x "$EXEC" || fail "无法为可执行文件添加运行权限: $EXEC"
if [[ -f "$APP_DIR/resources/native/pspore-startup" ]]; then
  chmod 0755 "$APP_DIR/resources/native/pspore-startup" || fail "无法为原生启动器添加运行权限。"
fi

resolve_desktop_dir() {
  local dir=""
  if command -v xdg-user-dir >/dev/null 2>&1; then
    dir="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
  fi
  if [[ -n "$dir" && -d "$dir" ]]; then
    printf '%s\n' "$dir"
    return
  fi
  for candidate in "$HOME/Desktop" "$HOME/桌面"; do
    if [[ -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  mkdir -p "$HOME/Desktop"
  printf '%s\n' "$HOME/Desktop"
}

desktop_exec_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//\$/\\\$}"
  value="${value//\`/\\\`}"
  value="${value//%/%%}"
  printf '%s' "$value"
}

install_launcher() {
  local install_tmp launcher_tmp
  mkdir -p "$LAUNCHER_DIR" "$(dirname -- "$LOG_FILE")"
  chmod 700 "$APP_DATA_DIR" "$LAUNCHER_DIR" "$(dirname -- "$LOG_FILE")"

  install_tmp="$(mktemp "$APP_DATA_DIR/.install-dir.XXXXXX")"
  printf '%s\n' "$APP_DIR" > "$install_tmp"
  chmod 600 "$install_tmp"
  mv -f "$install_tmp" "$INSTALL_FILE"

  launcher_tmp="$(mktemp "$LAUNCHER_DIR/.launcher.XXXXXX")"
  cat > "$launcher_tmp" <<'LAUNCHER'
#!/usr/bin/env bash
set -u
umask 077

data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
install_file="$data_home/pspore/install-dir"
log_dir="$state_home/pspore"
log_file="$log_dir/desktop-launcher.log"
mkdir -p "$log_dir"
chmod 700 "$log_dir" 2>/dev/null || true

if [[ "${1:-}" == "--launcher-log" ]]; then
  touch "$log_file"
  chmod 600 "$log_file" 2>/dev/null || true
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$log_file" >/dev/null 2>&1 || true
  else
    printf '%s\n' "$log_file"
  fi
  exit 0
fi

if [[ -f "$log_file" ]]; then
  log_size="$(wc -c < "$log_file" 2>/dev/null || printf '0')"
  if [[ "$log_size" =~ ^[0-9]+$ ]] && (( log_size > 1048576 )); then
    mv -f "$log_file" "$log_file.1"
  fi
fi
exec >> "$log_file" 2>&1
timestamp="$(date --iso-8601=seconds 2>/dev/null || date)"

if [[ ! -r "$install_file" ]]; then
  printf '[%s] launcher error: missing install record: %s\n' "$timestamp" "$install_file"
  exit 1
fi
if ! IFS= read -r app_dir < "$install_file" || [[ "$app_dir" != /* ]]; then
  printf '[%s] launcher error: invalid install record: %s\n' "$timestamp" "$install_file"
  exit 1
fi

binary="$app_dir/pspore-desktop"
if [[ ! -x "$binary" ]]; then
  printf '[%s] launcher error: executable is missing or not executable: %s\n' "$timestamp" "$binary"
  exit 1
fi
if ! cd "$app_dir"; then
  printf '[%s] launcher error: cannot enter install directory: %s\n' "$timestamp" "$app_dir"
  exit 1
fi

printf '[%s] launching %s\n' "$timestamp" "$binary"
native_startup="$app_dir/resources/native/pspore-startup"
if [[ -x "$native_startup" ]]; then
  # Keep a parent shell: exec would discard the only fallback before the ELF
  # loader can report missing libraries, ABI mismatches or an invalid binary.
  # The native helper exits 0 after normal quit, cancellation or activation of
  # an existing instance, so none of those paths should reopen the application.
  "$native_startup" "$binary" "$@" &
  native_pid=$!
  stop_native() {
    trap - TERM INT HUP
    kill -TERM "$native_pid" 2>/dev/null || true
    wait "$native_pid" 2>/dev/null || true
    exit 0
  }
  trap stop_native TERM INT HUP
  wait "$native_pid"
  native_status=$?
  trap - TERM INT HUP
  if (( native_status == 0 )); then
    exit 0
  fi
  printf '[%s] native startup exited with status %s; falling back to Electron\n' "$timestamp" "$native_status"
fi
unset PSPORE_STARTUP_SOCKET
exec "$binary" "$@"
LAUNCHER
  chmod 700 "$launcher_tmp"
  mv -f "$launcher_tmp" "$LAUNCHER"
}

install_icons() {
  local source="$APP_DIR/resources/icons" theme="$DATA_HOME/icons/hicolor"
  if [[ ! -f "$source/pspore.png" || ! -f "$source/pspore.svg" ]]; then
    fail "安装包缺少应用图标，请重新解压完整包或覆盖升级包。"
  fi
  # A theme name avoids embedding a versioned install path in pinned entries.
  install -Dm644 "$source/pspore.png" "$theme/512x512/apps/pspore.png"
  install -Dm644 "$source/pspore.svg" "$theme/scalable/apps/pspore.svg"
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -f -t "$theme" >/dev/null 2>&1 || true
  fi
}

write_desktop_file() {
  local target="$1" desktop_exec
  desktop_exec="$(desktop_exec_escape "$LAUNCHER")"
  cat > "$target" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=${APP_NAME}
Icon=pspore
Comment=Linux-first local proactive agent
Comment[zh_CN]=本地优先的主动式智能助手
Exec="${desktop_exec}"
Terminal=false
Categories=Utility;
StartupNotify=true
StartupWMClass=pSpore
Actions=LauncherLog;

[Desktop Action LauncherLog]
Name=Open launcher log
Name[zh_CN]=打开启动日志
Exec="${desktop_exec}" --launcher-log
EOF
  chmod 755 "$target"
}

install_icons
install_launcher
DESKTOP_DIR="$(resolve_desktop_dir)"
APPLICATIONS_DIR="$DATA_HOME/applications"
mkdir -p "$APPLICATIONS_DIR"

write_desktop_file "$DESKTOP_DIR/$DESKTOP_FILENAME"
write_desktop_file "$APPLICATIONS_DIR/$DESKTOP_FILENAME"

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$APPLICATIONS_DIR/$DESKTOP_FILENAME" \
    || fail "生成的应用菜单入口未通过 desktop-file-validate。"
fi
if command -v gio >/dev/null 2>&1; then
  gio set "$DESKTOP_DIR/$DESKTOP_FILENAME" metadata::trusted true 2>/dev/null || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPLICATIONS_DIR" 2>/dev/null || true
fi

echo "已创建桌面快捷方式："
echo "  $DESKTOP_DIR/$DESKTOP_FILENAME"
echo "并已加入应用菜单："
echo "  $APPLICATIONS_DIR/$DESKTOP_FILENAME"
echo "启动后右击任务栏中的 pSpore 图标，选择「固定到任务栏」或「加入收藏」。"
echo "启动日志："
echo "  $LOG_FILE"

if [[ "${PSPORE_SHORTCUT_SKIP_NOTIFY:-0}" != "1" ]] \
  && [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] \
  && command -v notify-send >/dev/null 2>&1; then
  notify-send "$APP_NAME" "桌面快捷方式已创建" || true
fi

if [[ -t 0 ]]; then
  read -r -p "按 Enter 关闭…" _ || true
fi
