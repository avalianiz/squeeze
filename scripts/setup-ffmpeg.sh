#!/usr/bin/env bash
# Install Squeeze FFmpeg/ffprobe sidecars for the current host.
#
# Prefer downloading CI-built artifacts (fast). Fall back to building from
# source only when SQUEEZE_FFMPEG_BUILD=1 or --build is passed.
#
# Usage:
#   ./scripts/setup-ffmpeg.sh
#   ./scripts/setup-ffmpeg.sh --build
#   SQUEEZE_FFMPEG_TAG=ffmpeg-v1.0.0 ./scripts/setup-ffmpeg.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARIES="$ROOT/src-tauri/binaries"
FORCE_BUILD=0
TAG="${SQUEEZE_FFMPEG_TAG:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)
      FORCE_BUILD=1
      shift
      ;;
    --tag)
      TAG="${2:?}"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1
      ;;
  esac
done

detect_triple() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os/$arch" in
    Linux/x86_64) echo "x86_64-unknown-linux-gnu" ;;
    Darwin/arm64) echo "aarch64-apple-darwin" ;;
    Darwin/x86_64) echo "x86_64-apple-darwin" ;;
    MINGW*/x86_64|MSYS*/x86_64|CYGWIN*/x86_64) echo "x86_64-pc-windows-msvc" ;;
    *)
      echo "error: unsupported host $os/$arch" >&2
      exit 1
      ;;
  esac
}

TRIPLE="$(detect_triple)"
EXE=""
[[ "$TRIPLE" == *windows* ]] && EXE=".exe"

FFMPEG_OUT="$BINARIES/ffmpeg-${TRIPLE}${EXE}"
FFPROBE_OUT="$BINARIES/ffprobe-${TRIPLE}${EXE}"

mkdir -p "$BINARIES"

if [[ -f "$FFMPEG_OUT" && -f "$FFPROBE_OUT" && "$FORCE_BUILD" -eq 0 ]]; then
  echo "FFmpeg sidecars already present for $TRIPLE:"
  ls -lh "$FFMPEG_OUT" "$FFPROBE_OUT"
  exit 0
fi

download_from_release() {
  if [[ -z "$TAG" ]]; then
    # Latest ffmpeg-sidecars release asset naming: squeeze-ffmpeg-<triple>.tar.gz
    if ! command -v gh >/dev/null 2>&1; then
      return 1
    fi
    local repo
    repo="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
    if [[ -z "$repo" ]]; then
      return 1
    fi
    echo "Downloading latest ffmpeg sidecars for $TRIPLE from $repo ..."
    local tmp
    tmp="$(mktemp -d)"
    if ! gh release download -R "$repo" -p "squeeze-ffmpeg-${TRIPLE}.tar.gz" -D "$tmp" 2>/dev/null; then
      # Try releases that start with ffmpeg-
      local latest
      latest="$(gh release list -R "$repo" --limit 20 | awk '/ffmpeg-sidecars/ {print $1; exit}')"
      if [[ -z "$latest" ]]; then
        rm -rf "$tmp"
        return 1
      fi
      gh release download -R "$repo" "$latest" -p "squeeze-ffmpeg-${TRIPLE}.tar.gz" -D "$tmp"
    fi
    tar -xzf "$tmp/squeeze-ffmpeg-${TRIPLE}.tar.gz" -C "$BINARIES"
    rm -rf "$tmp"
    return 0
  fi

  if ! command -v gh >/dev/null 2>&1; then
    echo "error: gh CLI required to download tag $TAG" >&2
    return 1
  fi
  local tmp
  tmp="$(mktemp -d)"
  gh release download -R "$(gh repo view --json nameWithOwner -q .nameWithOwner)" "$TAG" \
    -p "squeeze-ffmpeg-${TRIPLE}.tar.gz" -D "$tmp"
  tar -xzf "$tmp/squeeze-ffmpeg-${TRIPLE}.tar.gz" -C "$BINARIES"
  rm -rf "$tmp"
}

if [[ "$FORCE_BUILD" -eq 1 || "${SQUEEZE_FFMPEG_BUILD:-0}" == "1" ]]; then
  echo "Building FFmpeg from source for $TRIPLE (this takes a while)..."
  bash "$ROOT/scripts/ffmpeg/build.sh" --target "$TRIPLE" --out-dir "$BINARIES"
else
  if ! download_from_release; then
    echo "No prebuilt sidecar release found for $TRIPLE."
    echo "Building from source (set SQUEEZE_FFMPEG_BUILD=0 and publish CI artifacts to skip this)..."
    bash "$ROOT/scripts/ffmpeg/build.sh" --target "$TRIPLE" --out-dir "$BINARIES"
  fi
fi

if [[ ! -f "$FFMPEG_OUT" || ! -f "$FFPROBE_OUT" ]]; then
  echo "error: expected sidecars missing after setup" >&2
  exit 1
fi

echo "Installed sidecars:"
ls -lh "$FFMPEG_OUT" "$FFPROBE_OUT"

if command -v bash >/dev/null 2>&1 && [[ "$TRIPLE" != *windows* || -n "${WSL_DISTRO_NAME:-}" ]]; then
  bash "$ROOT/scripts/ffmpeg/verify-capabilities.sh" "$FFMPEG_OUT" || true
fi
