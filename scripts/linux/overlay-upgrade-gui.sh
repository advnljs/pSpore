#!/usr/bin/env bash
# Minimal desktop front end for 覆盖升级.sh: pick the install directory, then
# watch a progress bar. It only drives the same updater the terminal uses, so
# validation, rollback and the shortcut refresh behave identically either way.
#
# Falls back to the terminal script when no GTK/Qt dialog tool is available.
set -uo pipefail
umask 077

HERE="$(cd "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
UPDATER="$HERE/覆盖升级.sh"
TITLE="pSpore 覆盖升级"
LOG=""

cleanup() {
  [[ -n "$LOG" && -f "$LOG" ]] && rm -f -- "$LOG"
}
trap cleanup EXIT

if [[ ! -x "$UPDATER" ]]; then
  if [[ -f "$UPDATER" ]]; then
    chmod 0755 "$UPDATER" 2>/dev/null || true
  fi
fi
if [[ ! -f "$UPDATER" ]]; then
  echo "升级包不完整：未找到 $UPDATER" >&2
  exit 1
fi

DIALOG=""
if command -v zenity >/dev/null 2>&1; then
  DIALOG="zenity"
elif command -v kdialog >/dev/null 2>&1; then
  DIALOG="kdialog"
fi

if [[ -z "$DIALOG" ]]; then
  echo "未找到 zenity 或 kdialog，改用终端模式。" >&2
  exec bash "$UPDATER" "$@"
fi

# zenity renders --text as Pango markup, so updater output (which contains
# paths and quotes) has to be escaped before it is shown.
escape_markup() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

notify_error() {
  case "$DIALOG" in
    zenity) zenity --error --no-wrap --title="$TITLE" --text="$(escape_markup "$1")" 2>/dev/null || true ;;
    kdialog) kdialog --title "$TITLE" --error "$1" 2>/dev/null || true ;;
  esac
}

notify_info() {
  case "$DIALOG" in
    zenity) zenity --info --no-wrap --title="$TITLE" --text="$(escape_markup "$1")" 2>/dev/null || true ;;
    kdialog) kdialog --title "$TITLE" --msgbox "$1" 2>/dev/null || true ;;
  esac
}

# Prefer the directory the desktop shortcut already launches, then a sibling
# install, so the common case is one click on "确定".
default_directory() {
  local record="${XDG_DATA_HOME:-$HOME/.local/share}/pspore/install-dir"
  local candidate
  if [[ -r "$record" ]] && IFS= read -r candidate < "$record" && [[ -x "$candidate/pspore-desktop" ]]; then
    printf '%s\n' "$candidate"
    return
  fi
  if [[ -x "$HERE/pspore-desktop" ]]; then
    printf '%s\n' "$HERE"
    return
  fi
  printf '%s\n' "$HOME"
}

TARGET="${1:-}"
if [[ -z "$TARGET" ]]; then
  START="$(default_directory)"
  case "$DIALOG" in
    zenity)
      TARGET="$(zenity --file-selection --directory --title="$TITLE：选择已安装目录" --filename="$START/" 2>/dev/null)"
      ;;
    kdialog)
      TARGET="$(kdialog --title "$TITLE：选择已安装目录" --getexistingdirectory "$START" 2>/dev/null)"
      ;;
  esac
fi
if [[ -z "$TARGET" ]]; then
  exit 0
fi
if [[ ! -x "$TARGET/pspore-desktop" || ! -f "$TARGET/resources/app.asar" ]]; then
  notify_error "所选目录不是完整的 pSpore 安装目录：\n$TARGET\n\n请选择包含 pspore-desktop 的目录。"
  exit 1
fi

LOG="$(mktemp "${TMPDIR:-/tmp}/pspore-overlay-XXXXXX.log")"
STATUS_FILE="$(mktemp "${TMPDIR:-/tmp}/pspore-overlay-status-XXXXXX")"

run_updater() {
  # Progress lines look like "[ 45%] message"; everything else is detail that
  # belongs in the log and, on failure, in the error dialog.
  bash "$UPDATER" "$TARGET" 2>&1 | while IFS= read -r line; do
    printf '%s\n' "$line" >> "$LOG"
    if [[ "$line" =~ ^\[[[:space:]]*([0-9]+)%\][[:space:]](.*)$ ]]; then
      printf '%s\n' "${BASH_REMATCH[1]}"
      printf '# %s\n' "${BASH_REMATCH[2]}"
    fi
  done
  printf '%s\n' "${PIPESTATUS[0]}" > "$STATUS_FILE"
}

case "$DIALOG" in
  zenity)
    run_updater | zenity --progress \
      --title="$TITLE" \
      --text="正在准备升级…" \
      --percentage=0 \
      --auto-close \
      --no-cancel 2>/dev/null
    ;;
  kdialog)
    # kdialog has no stdin progress protocol, so drive its D-Bus bar when qdbus
    # is present and otherwise just run the updater to completion.
    if command -v qdbus >/dev/null 2>&1; then
      reference="$(kdialog --title "$TITLE" --progressbar "正在升级 pSpore…" 100 2>/dev/null)"
      run_updater | while IFS= read -r value; do
        [[ "$value" =~ ^[0-9]+$ ]] && qdbus ${reference} Set "" value "$value" >/dev/null 2>&1
      done
      qdbus ${reference} close >/dev/null 2>&1 || true
    else
      run_updater > /dev/null
    fi
    ;;
esac

STATUS="$(cat "$STATUS_FILE" 2>/dev/null || printf '1')"
rm -f -- "$STATUS_FILE"

if [[ "$STATUS" == "0" ]]; then
  notify_info "$(tail -n 12 "$LOG")"
  exit 0
fi

notify_error "升级未完成。\n\n$(tail -n 12 "$LOG")"
exit 1
