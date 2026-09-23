#!/usr/bin/env bash
# Validate a built ffmpeg binary exposes every component Squeeze requires.
# Usage: ./scripts/ffmpeg/verify-capabilities.sh /path/to/ffmpeg

set -euo pipefail

FFMPEG="${1:?usage: verify-capabilities.sh <ffmpeg-binary>}"

need_encoder() {
  local name="$1"
  "$FFMPEG" -hide_banner -encoders 2>/dev/null | grep -Eiq "(^|[[:space:]])${name}([[:space:]]|$)" \
    || { echo "MISSING encoder: $name" >&2; return 1; }
}

need_decoder() {
  local name="$1"
  "$FFMPEG" -hide_banner -decoders 2>/dev/null | grep -Eiq "(^|[[:space:]])${name}([[:space:]]|$)" \
    || { echo "MISSING decoder: $name" >&2; return 1; }
}

need_filter() {
  local name="$1"
  "$FFMPEG" -hide_banner -filters 2>/dev/null | grep -Eiq "(^|[[:space:]])${name}([[:space:]]|$)" \
    || { echo "MISSING filter: $name" >&2; return 1; }
}

need_demuxer() {
  local name="$1"
  "$FFMPEG" -hide_banner -demuxers 2>/dev/null | grep -Eiq "(^|[[:space:]])${name}([[:space:]]|$)" \
    || { echo "MISSING demuxer: $name" >&2; return 1; }
}

need_muxer() {
  local name="$1"
  "$FFMPEG" -hide_banner -muxers 2>/dev/null | grep -Eiq "(^|[[:space:]])${name}([[:space:]]|$)" \
    || { echo "MISSING muxer: $name" >&2; return 1; }
}

need_encoder libx264
need_encoder aac
need_filter scale
need_filter fps
need_muxer mp4
need_demuxer mov
need_demuxer matroska
need_demuxer avi
need_demuxer asf
need_demuxer flv
need_decoder h264
need_decoder aac

echo "All required capabilities present in: $FFMPEG"
