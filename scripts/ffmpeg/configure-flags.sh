#!/usr/bin/env bash
# Shared FFmpeg configure flags for Squeeze sidecars.
# FFmpeg splits --enable-demuxer=a,b on commas — use short names only (mov, matroska).

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
  --disable-ffplay

  --enable-gpl
  --enable-static
  --disable-shared
  --enable-runtime-cpudetect
  --enable-pic

  --enable-ffmpeg
  --enable-ffprobe

  --enable-avcodec
  --enable-avformat
  --enable-avutil
  --enable-avfilter
  --enable-swscale
  --enable-swresample

  --enable-libx264

  --enable-protocol=file
  --enable-protocol=pipe
  --enable-protocol=data

  --enable-demuxer=mov
  --enable-demuxer=matroska
  --enable-demuxer=avi
  --enable-demuxer=asf
  --enable-demuxer=flv
  --enable-demuxer=image2
  --enable-demuxer=gif

  --enable-muxer=mp4
  --enable-muxer=mov
  --enable-muxer=null

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

  --enable-encoder=libx264
  --enable-encoder=aac

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
