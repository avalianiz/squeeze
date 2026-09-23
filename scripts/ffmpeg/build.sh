#!/usr/bin/env bash
# Build Squeeze-minimal static ffmpeg + ffprobe for one Tauri target triple.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=versions.env
source "$ROOT/scripts/ffmpeg/versions.env"
# shellcheck source=configure-flags.sh
source "$ROOT/scripts/ffmpeg/configure-flags.sh"

TARGET=""
OUT_DIR="$ROOT/src-tauri/binaries"
WORK_DIR="${SQUEEZE_FFMPEG_WORK_DIR:-${FFMPEG_WORK_DIR:-$ROOT/.ffmpeg-build}}"
JOBS="${SQUEEZE_FFMPEG_JOBS:-$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)}"

usage() {
  cat <<'EOF'
Usage: build.sh --target <triple> [--out-dir DIR]
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="${2:?}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "error: --target is required" >&2
  exit 1
fi

EXE_SUFFIX=""
case "$TARGET" in
  x86_64-pc-windows-msvc) EXE_SUFFIX=".exe" ;;
  x86_64-unknown-linux-gnu|aarch64-apple-darwin|x86_64-apple-darwin) ;;
  *) echo "error: unsupported target '$TARGET'" >&2; exit 1 ;;
esac

mkdir -p "$WORK_DIR" "$OUT_DIR"
cd "$WORK_DIR"
echo "WORK_DIR=$WORK_DIR OUT_DIR=$OUT_DIR TARGET=$TARGET JOBS=$JOBS"

fetch_x264() {
  if [[ -d x264/.git ]]; then
    echo "x264 already present"
    return 0
  fi
  rm -rf x264
  echo "Cloning x264..."
  # Prefer GitHub mirror (more reliable on Actions than code.videolan.org).
  if git clone --depth 1 https://github.com/mirror/x264.git x264; then
    return 0
  fi
  git clone --depth 1 https://code.videolan.org/videolan/x264.git x264
}

fetch_ffmpeg() {
  local tag="n${FFMPEG_VERSION}"
  if [[ -d ffmpeg/.git ]]; then
    echo "ffmpeg already present"
    return 0
  fi
  rm -rf ffmpeg
  echo "Cloning FFmpeg $tag..."
  git clone --depth 1 --branch "$tag" https://github.com/FFmpeg/FFmpeg.git ffmpeg
}

require_x264_pc() {
  local prefix="$1"
  local pc=""
  for candidate in \
    "$prefix/lib/pkgconfig/x264.pc" \
    "$prefix/lib64/pkgconfig/x264.pc" \
    "$prefix/lib/x86_64-linux-gnu/pkgconfig/x264.pc"
  do
    if [[ -f "$candidate" ]]; then
      pc="$candidate"
      break
    fi
  done
  if [[ -z "$pc" ]]; then
    echo "error: x264.pc not found under $prefix after install" >&2
    find "$prefix" -name 'x264*' -print >&2 || true
    exit 1
  fi
  local pcdir
  pcdir="$(dirname "$pc")"
  export PKG_CONFIG_PATH="$pcdir${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
  echo "Found $pc"
  pkg-config --exists x264 || {
    echo "error: pkg-config cannot resolve x264" >&2
    pkg-config --debug x264 >&2 || true
    exit 1
  }
  echo "x264 version: $(pkg-config --modversion x264)"
  echo "x264 cflags: $(pkg-config --cflags x264)"
  echo "x264 libs: $(pkg-config --libs --static x264)"
}

build_x264_unix() {
  local prefix="$1"
  shift
  pushd x264 >/dev/null
  make distclean >/dev/null 2>&1 || true
  echo "Configuring x264..."
  ./configure \
    --prefix="$prefix" \
    --enable-static \
    --disable-cli \
    --disable-shared \
    --enable-pic \
    "$@"
  make -j"$JOBS"
  make install
  popd >/dev/null
  require_x264_pc "$prefix"
}

dump_ffmpeg_config_log() {
  pushd ffmpeg >/dev/null || return 0
  for f in ffbuild/config.log config.log; do
    if [[ -f "$f" ]]; then
      echo "===== $f (tail) =====" >&2
      tail -n 120 "$f" >&2 || true
    fi
  done
  popd >/dev/null || true
}

build_ffmpeg_unix() {
  local prefix="$1"
  shift
  # remaining args: extra configure flags

  require_x264_pc "$prefix"
  pushd ffmpeg >/dev/null
  make distclean >/dev/null 2>&1 || true

  echo "Configuring FFmpeg..."
  if ! ./configure \
    --prefix="$prefix" \
    --pkg-config-flags="--static" \
    --extra-cflags="-I${prefix}/include" \
    --extra-ldflags="-L${prefix}/lib" \
    "${SQUEEZE_FFMPEG_CONFIGURE_FLAGS[@]}" \
    "$@"; then
    dump_ffmpeg_config_log
    exit 1
  fi

  make -j"$JOBS"
  make install
  popd >/dev/null
}

install_sidecars() {
  local prefix="$1"
  local ffmpeg_src="$prefix/bin/ffmpeg${EXE_SUFFIX}"
  local ffprobe_src="$prefix/bin/ffprobe${EXE_SUFFIX}"
  local ffmpeg_dst="$OUT_DIR/ffmpeg-${TARGET}${EXE_SUFFIX}"
  local ffprobe_dst="$OUT_DIR/ffprobe-${TARGET}${EXE_SUFFIX}"

  if [[ ! -f "$ffmpeg_src" ]]; then
    ffmpeg_src="$prefix/bin/ffmpeg"
    ffprobe_src="$prefix/bin/ffprobe"
    if [[ -n "$EXE_SUFFIX" && -f "${ffmpeg_src}${EXE_SUFFIX}" ]]; then
      ffmpeg_src="${ffmpeg_src}${EXE_SUFFIX}"
      ffprobe_src="${ffprobe_src}${EXE_SUFFIX}"
    fi
  fi

  if [[ ! -f "$ffmpeg_src" || ! -f "$ffprobe_src" ]]; then
    echo "error: expected binaries missing under $prefix/bin" >&2
    ls -la "$prefix/bin" >&2 || true
    exit 1
  fi

  cp -f "$ffmpeg_src" "$ffmpeg_dst"
  cp -f "$ffprobe_src" "$ffprobe_dst"
  chmod +x "$ffmpeg_dst" "$ffprobe_dst" 2>/dev/null || true
  ls -lh "$ffmpeg_dst" "$ffprobe_dst"
}

verify_sidecars() {
  local ffmpeg_dst="$OUT_DIR/ffmpeg-${TARGET}${EXE_SUFFIX}"
  if [[ "$TARGET" == *windows* && "$(uname -s)" != MINGW* && "$(uname -s)" != MSYS* && "$(uname -s)" != CYGWIN* ]]; then
    echo "Skipping runtime verify for cross-built Windows binaries."
    return 0
  fi
  if [[ "$TARGET" == "x86_64-apple-darwin" && "$(uname -m)" == "arm64" ]]; then
    echo "Skipping runtime verify for cross-built x86_64 macOS binary."
    return 0
  fi
  if [[ "$TARGET" == "aarch64-apple-darwin" && "$(uname -m)" == "x86_64" ]]; then
    echo "Skipping runtime verify for aarch64 binary on x86_64 host."
    return 0
  fi

  "$ffmpeg_dst" -hide_banner -encoders 2>/dev/null | grep -q 'libx264' \
    || { echo "error: libx264 encoder missing" >&2; exit 1; }
  "$ffmpeg_dst" -hide_banner -encoders 2>/dev/null | grep -q 'aac' \
    || { echo "error: aac encoder missing" >&2; exit 1; }
  "$ffmpeg_dst" -hide_banner -filters 2>/dev/null | grep -q 'scale' \
    || { echo "error: scale filter missing" >&2; exit 1; }
  "$ffmpeg_dst" -hide_banner -filters 2>/dev/null | grep -q 'fps' \
    || { echo "error: fps filter missing" >&2; exit 1; }
  echo "Runtime verify OK."
}

case "$TARGET" in
  x86_64-unknown-linux-gnu)
    PREFIX="$WORK_DIR/prefix-linux-x64"
    rm -rf "$PREFIX"
    mkdir -p "$PREFIX"
    fetch_x264
    fetch_ffmpeg
    build_x264_unix "$PREFIX"
    build_ffmpeg_unix "$PREFIX" --extra-libs="-lpthread -lm"
    install_sidecars "$PREFIX"
    verify_sidecars
    ;;

  x86_64-pc-windows-msvc)
    if ! command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
      echo "error: x86_64-w64-mingw32-gcc not found" >&2
      exit 1
    fi
    PREFIX="$WORK_DIR/prefix-win-x64"
    rm -rf "$PREFIX"
    mkdir -p "$PREFIX"
    fetch_x264
    fetch_ffmpeg
    # pkg-config for cross builds often needs these.
    export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig"
    export PKG_CONFIG="pkg-config"
    build_x264_unix "$PREFIX" \
      --host=x86_64-w64-mingw32 \
      --cross-prefix=x86_64-w64-mingw32-
    # Rewrite x264.pc prefix if needed (mingw installs can confuse pkg-config).
    if [[ -f "$PREFIX/lib/pkgconfig/x264.pc" ]]; then
      sed -i.bak "s|^prefix=.*|prefix=$PREFIX|" "$PREFIX/lib/pkgconfig/x264.pc"
    fi
    build_ffmpeg_unix "$PREFIX" \
      --target-os=mingw32 \
      --arch=x86_64 \
      --cross-prefix=x86_64-w64-mingw32- \
      --extra-libs="-static -lpthread" \
      --enable-cross-compile \
      --pkg-config=pkg-config
    install_sidecars "$PREFIX"
    verify_sidecars
    ;;

  aarch64-apple-darwin|x86_64-apple-darwin)
    if [[ "$(uname -s)" != "Darwin" ]]; then
      echo "error: macOS targets must be built on macOS" >&2
      exit 1
    fi
    host_machine="$(uname -m)"
    want_arch="arm64"
    [[ "$TARGET" == "x86_64-apple-darwin" ]] && want_arch="x86_64"

    export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-11.0}"
    PREFIX="$WORK_DIR/prefix-${TARGET}"
    rm -rf "$PREFIX"
    mkdir -p "$PREFIX"
    fetch_x264
    fetch_ffmpeg

    if [[ "$host_machine" == "$want_arch" ]]; then
      build_x264_unix "$PREFIX"
      build_ffmpeg_unix "$PREFIX" --extra-libs="-lpthread -lm"
    else
      echo "Cross-compiling macOS $want_arch on $host_machine host..."
      export CC="clang -arch ${want_arch}"
      export CXX="clang++ -arch ${want_arch}"
      build_x264_unix "$PREFIX" \
        --host="${want_arch}-apple-darwin" \
        --extra-cflags="-arch ${want_arch}" \
        --extra-ldflags="-arch ${want_arch}"
      build_ffmpeg_unix "$PREFIX" \
        --enable-cross-compile \
        --arch="${want_arch}" \
        --target-os=darwin \
        --cc="clang -arch ${want_arch}" \
        --extra-cflags="-arch ${want_arch}" \
        --extra-ldflags="-arch ${want_arch}" \
        --extra-libs="-lpthread -lm"
      unset CC CXX
    fi
    install_sidecars "$PREFIX"
    verify_sidecars
    ;;
esac

echo "Done: $TARGET"
