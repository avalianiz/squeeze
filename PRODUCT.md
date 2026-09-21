# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who need clips small enough to upload to Discord and other social platforms, and who also want to reclaim disk space from oversized local recordings. They want a simple, lightweight desktop app — not a video suite.

## Product Purpose

Squeeze compresses (and optionally trims) videos locally so they fit platform upload limits and take less space on disk. Success is: drop or pick clips, get files under the target size, without leaving the machine or learning an encoder UI.

## Positioning

Local-only, lightweight compressor aimed at social upload size limits (Discord’s ~20 MB as the primary default), with batch queue and optional trim — not a cloud service, editor, or general media converter.

## Operating Context

Desktop use beside Discord / social upload flows and local clip folders. Typical ritual: grab a recording or folder → squeeze → upload or keep the smaller file. Relies on local ffmpeg/ffprobe tooling; files never leave the device.

## Capabilities and Constraints

Confirmed today:
- Local only; no cloud upload or account
- Compress toward Discord’s ~20 MB target
- Preview + dual-handle trim timeline before queueing a single file
- Separate Trim-only jobs (stream-copy cut) that also apply when Squeeze is used with a trim range
- Optional output rename per clip
- Drag/drop and pick files or folders; recursive folder ingest
- Job queue with progress, cancel, retry, clear finished
- Output beside original or safe replace of originals
- Custom undecorated window chrome (minimize / maximize / close)

Desired / not yet fully productized:
- Adjustable size thresholds beyond the hard 20 MB aim, with clear warnings when a target is unrealistic (e.g. ~1 MB)

Undecided:
- Exact set of “other social” presets vs a single custom size control

## Brand Commitments

Product name: **Squeeze**. Voice and other identity copy may change; the name stays.

## Evidence on Hand

Runnable Tauri 2 + React/Vite UI (`src/App.tsx`, `src/App.css`) and Rust/ffmpeg pipeline (`src-tauri/`). No marketing site, testimonials, or fabricated claims. Do not invent customers, benchmarks, or licensing.

## Product Principles

1. Stay local — never require network or accounts for the core job.
2. Optimize for the upload-limit moment, not for general video production.
3. Keep the app lightweight and obvious: few controls, clear outcomes.
4. Be honest about what’s possible — warn when a size target can’t work.
5. Preserve user files: safe replace, predictable output beside originals.
