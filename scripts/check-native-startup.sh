#!/usr/bin/env bash
set -euo pipefail
STARTUP="${1:?Usage: check-native-startup.sh /path/to/pspore-startup}"
export LC_ALL=C
case "$(uname -m)" in
  x86_64) MACHINE='Advanced Micro Devices X86-64' ;;
  aarch64) MACHINE='AArch64' ;;
  *) echo "Unsupported native startup architecture" >&2; exit 1 ;;
esac
readelf --file-header "$STARTUP" | grep -F "$MACHINE" >/dev/null
# This helper needs no libc API newer than 2.17. Keep it below Electron's
# requirement; modern crt objects can silently add __libc_start_main@2.34.
VERSIONS="$(readelf --version-info "$STARTUP" | sed -n 's/.*Name: GLIBC_\([0-9.]*\).*/\1/p')"
if [[ -z "$VERSIONS" ]]; then
  echo "Native startup has no inspectable GLIBC requirements" >&2
  exit 1
fi
MAXIMUM="$(printf '%s\n' "$VERSIONS" | sort -Vu | tail -n 1)"
if [[ "$(printf '%s\n' 2.17 "$MAXIMUM" | sort -V | tail -n 1)" != '2.17' ]]; then
  echo "Native startup requires GLIBC_${MAXIMUM}; maximum is 2.17. Build with scripts/build-native-startup-container.sh or an older Linux toolchain." >&2
  exit 1
fi
printf 'Native startup ABI verified: %s, GLIBC_%s (maximum 2.17)\n' "$MACHINE" "$MAXIMUM"
