#!/usr/bin/env bash
# Shared FFmpeg configure flags for Squeeze sidecars.
#
# Derived from Squeeze's ffmpeg/ffprobe usage in src-tauri/src/media/
# and supported input extensions. Do not shrink without re-auditing.
#
# Philosophy: --disable-everything, then enable only what Squeeze needs
# for current workflows — not "smallest binary at any cost."
#
# IMPORTANT: FFmpeg configure splits --enable-demuxer=a,b on commas into
# separate names. Use the short component name (mov, matroska), not the
# multi-alias display string (mov,mp4,...).

# shellcheck disable=SC2034
SQUEEZE_FFMPEG_CONFIGURE_FLAGS=(
  --disable-everything
  --disable-autodetect
  --disable-network
  --disable-debug
  --disable-doc
  --disable-htmlpages
  --disable-manpages
  --disable-podpages
  --disable-txtpages
  --disable-indevs
  --disable-outdevs
  --disable-devices
  --disable-hwaccels
  --disable-iconv
  --disable-lzma
  --disable-bzlib
  --disable-libxcb
  --disable-sdl2
  --disable-xlib
  --disable-alsa
  --disable-sndio

  --enable-gpl
  --enable-static
  --disable-shared
  --enable-runtime-cpudetect
  --enable-pic

  # Programs Squeeze ships as Tauri sidecars
  --enable-ffmpeg
  --enable-ffprobe
  --disable-ffplay

  # Core libs (scale filter needs swscale; aresample may be pulled by aac path)
  --enable-avcodec
  --enable-avformat
  --enable-avutil
  --enable-avfilter
  --enable-swscale
  --enable-swresample

  # External encoder used by Squeeze compress path (-c:v libx264)
  --enable-libx264

  # --- Protocols (file I/O + progress on pipe:1) ---
  --enable-protocol=file
  --enable-protocol=pipe
  --enable-protocol=data

  # --- Demuxers matching VIDEO_EXTENSIONS ---
  # Short names only (mov covers mp4/m4v/mov; matroska covers mkv/webm)
  --enable-demuxer=mov
  --enable-demuxer=matroska
  --enable-demuxer=avi
  --enable-demuxer=asf
  --enable-demuxer=flv
  --enable-demuxer=image2
  --enable-demuxer=gif

  # --- Muxers (Squeeze always writes .mp4) ---
  --enable-muxer=mp4
  --enable-muxer=mov
  --enable-muxer=null

  # --- Parsers ---
  --enable-parser=h264
  --enable-parser=hevc
  --enable-parser=aac
  --enable-parser=aac_latm
  --enable-parser=mpegaudio
  --enable-parser=opus
  --enable-parser=vorbis
  --enable-parser=vp8
  --enable-parser=vp9
  --enable-parser=av1
  --enable-parser=mpeg4video
  --enable-parser=mpegvideo
  --enable-parser=ac3
  --enable-parser=flac
  --enable-parser=vc1
  --enable-parser=mjpeg
  --enable-parser=vp3

  # --- Video decoders ---
  --enable-decoder=h264
  --enable-decoder=hevc
  --enable-decoder=vp8
  --enable-decoder=vp9
  --enable-decoder=av1
  --enable-decoder=mpeg4
  --enable-decoder=mpeg1video
  --enable-decoder=mpeg2video
  --enable-decoder=mjpeg
  --enable-decoder=wmv1
  --enable-decoder=wmv2
  --enable-decoder=wmv3
  --enable-decoder=vc1
  --enable-decoder=flv
  --enable-decoder=h263
  --enable-decoder=msmpeg4v1
  --enable-decoder=msmpeg4v2
  --enable-decoder=msmpeg4v3
  --enable-decoder=theora
  --enable-decoder=prores
  --enable-decoder=png
  --enable-decoder=gif

  # --- Audio decoders ---
  --enable-decoder=aac
  --enable-decoder=aac_latm
  --enable-decoder=mp3
  --enable-decoder=mp3float
  --enable-decoder=mp2
  --enable-decoder=opus
  --enable-decoder=vorbis
  --enable-decoder=flac
  --enable-decoder=ac3
  --enable-decoder=eac3
  --enable-decoder=wmav1
  --enable-decoder=wmav2
  --enable-decoder=alac
  --enable-decoder=pcm_s16le
  --enable-decoder=pcm_s16be
  --enable-decoder=pcm_s24le
  --enable-decoder=pcm_s32le
  --enable-decoder=pcm_f32le
  --enable-decoder=pcm_bluray
  --enable-decoder=pcm_dvd

  # --- Encoders ---
  --enable-encoder=libx264
  --enable-encoder=aac

  # --- Filters ---
  --enable-filter=scale
  --enable-filter=fps
  --enable-filter=null
  --enable-filter=anull
  --enable-filter=aresample
  --enable-filter=format
  --enable-filter=aformat
  --enable-filter=buffer
  --enable-filter=buffersink
  --enable-filter=abuffer
  --enable-filter=abuffersink

  # --- Bitstream filters ---
  --enable-bsf=aac_adtstoasc
  --enable-bsf=h264_mp4toannexb
  --enable-bsf=hevc_mp4toannexb
  --enable-bsf=extract_extradata
  --enable-bsf=dump_extra
  --enable-bsf=null
  --enable-bsf=vp9_superframe
  --enable-bsf=vp9_superframe_split
  --enable-bsf=av1_frame_merge
  --enable-bsf=av1_frame_split
  --enable-bsf=filter_units
)
