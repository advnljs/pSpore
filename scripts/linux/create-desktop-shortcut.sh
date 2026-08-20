#!/usr/bin/env bash
# Double-click this script after extracting the full desktop zip to create a
# launcher on the Desktop and in the application menu.
set -euo pipefail

APP_DIR="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXEC="$APP_DIR/pspore-desktop"
APP_NAME="pSpore"
DESKTOP_FILENAME="pSpore.desktop"

fail() {
  echo "$1" >&2
  if [[ -t 0 ]] || [[ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]]; then
    read -r -p "按 Enter 关闭…" _ || true
  fi
  exit 1
}

if [[ ! -f "$EXEC" ]]; then
  fail "未找到可执行文件: $EXEC"
fi
chmod +x "$EXEC" || true

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

write_desktop_file() {
  local target="$1"
  cat > "$target" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=${APP_NAME}
Comment=Linux-first local proactive agent
Exec="${EXEC}"
Path="${APP_DIR}"
Terminal=false
Categories=Utility;Development;
StartupNotify=true
StartupWMClass=pSpore
EOF
  chmod +x "$target"
}

DESKTOP_DIR="$(resolve_desktop_dir)"
APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPLICATIONS_DIR"

write_desktop_file "$DESKTOP_DIR/$DESKTOP_FILENAME"
write_desktop_file "$APPLICATIONS_DIR/$DESKTOP_FILENAME"

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

if command -v notify-send >/dev/null 2>&1; then
  notify-send "$APP_NAME" "桌面快捷方式已创建" || true
fi

if [[ -t 0 ]]; then
  read -r -p "按 Enter 关闭…" _ || true
fi
