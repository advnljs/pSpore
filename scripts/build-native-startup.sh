#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="${1:?Usage: build-native-startup.sh /path/to/pspore-startup}"
if [[ -n "${PSPORE_NATIVE_STARTUP_BINARY:-}" ]]; then
  bash "$ROOT/scripts/check-native-startup.sh" "$PSPORE_NATIVE_STARTUP_BINARY"
  install -Dm755 "$PSPORE_NATIVE_STARTUP_BINARY" "$OUTPUT"
  exit 0
fi
PKG_CONFIG="${PKG_CONFIG:-pkg-config}"
if ! "$PKG_CONFIG" --exists gtk+-3.0 gio-unix-2.0; then
  echo "Native startup build needs libgtk-3-dev and pkg-config (build dependencies only)." >&2
  exit 1
fi
read -r -a CFLAGS <<< "$("$PKG_CONFIG" --cflags gtk+-3.0 gio-unix-2.0)"
read -r -a LIBS <<< "$("$PKG_CONFIG" --libs gtk+-3.0 gio-unix-2.0)"
mkdir -p "$(dirname "$OUTPUT")"
"${CC:-cc}" -O2 -Wall -Wextra -Werror -Wformat=2 -D_FORTIFY_SOURCE=2 \
  -fstack-protector-strong -DGLIB_VERSION_MIN_REQUIRED=GLIB_VERSION_2_64 \
  -DGLIB_VERSION_MAX_ALLOWED=GLIB_VERSION_2_64 \
  "${CFLAGS[@]}" "$ROOT/src/desktop/native/startup.c" \
  -o "$OUTPUT" "${LIBS[@]}" -lm -Wl,-z,relro,-z,now
chmod 0755 "$OUTPUT"
bash "$ROOT/scripts/check-native-startup.sh" "$OUTPUT"
