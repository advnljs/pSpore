#!/usr/bin/env bash
# Only the small GTK helper is built in the older userspace. The existing
# Electron/Node packaging environment remains independent of this toolchain.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="$(realpath -m "${1:?Usage: build-native-startup-container.sh /path/to/pspore-startup}")"
NODE_BINARY="$(readlink -f "$(command -v node)")"
mkdir -p "$(dirname "$OUTPUT")"
docker run --rm \
  --mount "type=bind,source=$ROOT,target=/source,readonly" \
  --mount "type=bind,source=$(dirname "$OUTPUT"),target=/output" \
  --mount "type=bind,source=$NODE_BINARY,target=/usr/local/bin/node,readonly" \
  --env "STARTUP_OUTPUT=$(basename "$OUTPUT")" \
  --env "BUILD_UID=$(id -u)" --env "BUILD_GID=$(id -g)" \
  ubuntu:20.04 bash -euc '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install --no-install-recommends --yes build-essential libgtk-3-dev pkg-config xvfb xauth x11-utils xdotool ca-certificates
    test "$(getconf GNU_LIBC_VERSION)" = "glibc 2.31"
    cd /source
    bash scripts/build-native-startup.sh "/output/$STARTUP_OUTPUT"
    xvfb-run -a -s "-screen 0 1920x1080x24" node scripts/native-startup-smoke.mjs "/output/$STARTUP_OUTPUT"
    chown "$BUILD_UID:$BUILD_GID" "/output/$STARTUP_OUTPUT"
  '
