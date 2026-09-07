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
for tool in unzip python3; do
  command -v "$tool" >/dev/null || { echo "Error: ${tool} is required" >&2; exit 1; }
done
# A private upstream repository serves release assets only to authenticated
# requests, so gh is preferred and curl is the fallback for public releases.
DOWNLOADER=""
if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  DOWNLOADER="gh"
elif command -v curl >/dev/null; then
  DOWNLOADER="curl"
else
  echo "Error: need either an authenticated gh, or curl for a public release" >&2
  exit 1
fi
echo "==> downloading with ${DOWNLOADER}"

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
    asset = skill["assetTemplate"].format(version=skill["version"], releaseArch=target["releaseArch"])
    print("\t".join([skill["name"], skill["repository"], skill["version"], asset, target["sha256"], target["binaryPath"]]))
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
  if [[ "$DOWNLOADER" == "gh" ]]; then
    echo "--- gh release download v${VERSION} ${ASSET} from ${REPOSITORY}"
    gh release download "v${VERSION}" --repo "$REPOSITORY" --pattern "$ASSET" --dir "$WORK" --clobber
  else
    echo "--- ${URL}"
    if ! curl -fsSL --retry 3 --retry-delay 2 "$URL" -o "$WORK/${ASSET}"; then
      echo "Error: could not download ${ASSET}." >&2
      echo "       If ${REPOSITORY} is private, authenticate gh (gh auth login) or set GH_TOKEN." >&2
      exit 1
    fi
  fi

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

  BINARY="$(find "$WORK/extract" -type f -path "*/${BINARY_PATH}" -print -quit)"
  if [[ -z "$BINARY" ]]; then
    echo "Error: ${ASSET} does not contain ${BINARY_PATH}" >&2
    exit 1
  fi
  SOURCE_DIR="$(dirname "$BINARY")"
  ARCH_DIR="$(basename "$SOURCE_DIR")"

  # Copy only what the CLI needs. The upstream package is built for the desktop
  # application, so its architecture directory also holds the ~200 MB Qt GUI
  # binary and Qt platform plugins; the CLI links no Qt and must not drag them
  # into every pSpore release.
  rm -rf "$DESTINATION"
  mkdir -p "$DESTINATION/$ARCH_DIR/lib"
  # The placeholder is what keeps bin/ tracked while its contents are ignored.
  : > "$DESTINATION/.gitkeep"
  install -m 0755 "$BINARY" "$DESTINATION/$ARCH_DIR/aegis-search"
  if [[ -d "$SOURCE_DIR/lib" ]]; then
    cp -a "$SOURCE_DIR/lib/." "$DESTINATION/$ARCH_DIR/lib/"
    # Qt is only there for the GUI; keeping it would roughly double the payload.
    rm -f "$DESTINATION/$ARCH_DIR/lib/"libQt5*

    # Drop everything the CLI does not actually load. The upstream lib directory
    # was collected for the desktop application, so it carries GL and X11 stacks
    # this binary never touches. Only possible when packaging natively, because
    # ldd cannot resolve a foreign architecture.
    if [[ "$(uname -m)" == "$ARCH_DIR" ]] && command -v ldd >/dev/null; then
      NEEDED="$WORK/needed.txt"
      if LD_LIBRARY_PATH="$DESTINATION/$ARCH_DIR/lib" ldd "$DESTINATION/$ARCH_DIR/aegis-search" 2>/dev/null \
        | awk '/=>/ {print $3}' | grep -F "$DESTINATION/$ARCH_DIR/lib/" \
        | xargs -r -n1 basename | sort -u > "$NEEDED" && [[ -s "$NEEDED" ]]; then
        BEFORE_MB="$(du -sm "$DESTINATION/$ARCH_DIR/lib" | cut -f1)"
        while IFS= read -r candidate; do
          grep -qxF "$candidate" "$NEEDED" || rm -f "$DESTINATION/$ARCH_DIR/lib/$candidate"
        done < <(ls -1 "$DESTINATION/$ARCH_DIR/lib")
        # Re-check: pruning must never leave the binary unable to start.
        if LD_LIBRARY_PATH="$DESTINATION/$ARCH_DIR/lib" ldd "$DESTINATION/$ARCH_DIR/aegis-search" 2>/dev/null | grep -q "not found"; then
          echo "Error: pruning removed a library the binary needs" >&2
          exit 1
        fi
        echo "--- pruned unused libraries: ${BEFORE_MB}MB -> $(du -sm "$DESTINATION/$ARCH_DIR/lib" | cut -f1)MB"
      fi
    fi
  fi

  # The launcher at the package root points at the architecture directory and
  # sets LD_LIBRARY_PATH, which is what makes the skill work on a machine with
  # no lucene++, poppler or libzip installed.
  LAUNCHER="$(find "$WORK/extract" -maxdepth 2 -type f -name "aegis-search" -not -path "*/${ARCH_DIR}/*" -print -quit)"
  if [[ -z "$LAUNCHER" ]]; then
    echo "Error: ${ASSET} does not contain a top-level aegis-search launcher" >&2
    exit 1
  fi
  install -m 0755 "$LAUNCHER" "$DESTINATION/aegis-search"

  if [[ ! -x "$DESTINATION/aegis-search" ]]; then
    echo "Error: ${NAME} is missing an executable entry point at bin/aegis-search" >&2
    exit 1
  fi
  echo "--- installed into bundled-skills/${NAME}/bin"
done

echo "==> Bundled binaries ready for ${ARCH}"
