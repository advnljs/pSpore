#!/usr/bin/env bash
# Downloads the native helper binaries that bundled skills need, pinned by
# version and verified by SHA-256.
#
# They are not committed to this repository: they are built and released by
# their own upstream project, and vendoring a multi-megabyte binary per
# architecture into git would bloat every clone. Packaging fetches them instead.
#
# Usage: bash scripts/fetch-bundled-binaries.sh [x64|arm64]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$REPO_ROOT/bundled-skills/binaries.json"
ARCH="${1:-}"

if [[ -z "$ARCH" ]]; then
  case "$(uname -m)" in
    x86_64) ARCH="x64" ;;
    aarch64) ARCH="arm64" ;;
    *)
      echo "Error: unsupported architecture $(uname -m); pass x64 or arm64 explicitly" >&2
      exit 1
      ;;
  esac
fi
case "$ARCH" in
  x64|arm64) ;;
  *)
    echo "Error: architecture must be x64 or arm64 (got ${ARCH})" >&2
    exit 1
    ;;
esac

if [[ ! -f "$MANIFEST" ]]; then
  echo "Error: missing ${MANIFEST}" >&2
  exit 1
fi
for tool in curl unzip python3; do
  command -v "$tool" >/dev/null || { echo "Error: ${tool} is required" >&2; exit 1; }
done

# One entry per skill; each names the upstream release asset and its digest.
mapfile -t ENTRIES < <(python3 - "$MANIFEST" "$ARCH" <<'PY'
import json, sys
manifest = json.load(open(sys.argv[1]))
arch = sys.argv[2]
for skill in manifest["skills"]:
    target = skill["architectures"].get(arch)
    if not target:
        print(f"Error: {skill['name']} has no {arch} asset", file=sys.stderr)
        raise SystemExit(1)
    print("\t".join([skill["name"], skill["repository"], skill["version"], target["asset"], target["sha256"], target["binaryPath"]]))
PY
)

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

for entry in "${ENTRIES[@]}"; do
  IFS=$'\t' read -r NAME REPOSITORY VERSION ASSET SHA256 BINARY_PATH <<< "$entry"
  DESTINATION="$REPO_ROOT/bundled-skills/${NAME}/bin"
  URL="https://github.com/${REPOSITORY}/releases/download/v${VERSION}/${ASSET}"

  echo "==> ${NAME} ${VERSION} (${ARCH})"
  if [[ "$SHA256" =~ ^0+$ ]]; then
    echo "Error: ${NAME} ${ARCH} has a placeholder digest in bundled-skills/binaries.json." >&2
    echo "       Publish the upstream release, then record its real SHA-256 there." >&2
    exit 1
  fi
  echo "--- ${URL}"
  curl -fsSL --retry 3 --retry-delay 2 "$URL" -o "$WORK/${ASSET}"

  ACTUAL="$(sha256sum "$WORK/${ASSET}" | awk '{print $1}')"
  if [[ "$ACTUAL" != "$SHA256" ]]; then
    echo "Error: ${ASSET} digest mismatch" >&2
    echo "  expected ${SHA256}" >&2
    echo "  actual   ${ACTUAL}" >&2
    exit 1
  fi
  echo "--- sha256 verified"

  rm -rf "$WORK/extract"
  mkdir -p "$WORK/extract"
  unzip -q "$WORK/${ASSET}" -d "$WORK/extract"

  SOURCE_DIR="$(dirname "$(find "$WORK/extract" -type f -path "*/${BINARY_PATH}" -print -quit)")"
  if [[ -z "$SOURCE_DIR" || ! -d "$SOURCE_DIR" ]]; then
    echo "Error: ${ASSET} does not contain ${BINARY_PATH}" >&2
    exit 1
  fi

  # The upstream package keeps the executable and its private shared libraries
  # under an architecture directory next to a launcher that sets the library
  # path. Copying that whole layout keeps the skill self-contained, so it works
  # on a machine that has none of lucene++, poppler or libzip installed.
  rm -rf "$DESTINATION"
  mkdir -p "$DESTINATION"
  cp -a "$SOURCE_DIR" "$DESTINATION/"
  LAUNCHER="$(find "$WORK/extract" -maxdepth 2 -type f -name "aegis-search" -not -path "*/$(basename "$SOURCE_DIR")/*" -print -quit)"
  if [[ -n "$LAUNCHER" ]]; then
    install -m 0755 "$LAUNCHER" "$DESTINATION/aegis-search"
  fi
  chmod 0755 "$DESTINATION/$(basename "$SOURCE_DIR")/$(basename "$BINARY_PATH")"

  if [[ ! -x "$DESTINATION/aegis-search" ]]; then
    echo "Error: ${NAME} is missing an executable entry point at bin/aegis-search" >&2
    exit 1
  fi
  echo "--- installed into bundled-skills/${NAME}/bin"
done

echo "==> Bundled binaries ready for ${ARCH}"
