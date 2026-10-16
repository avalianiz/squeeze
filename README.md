# Squeeze

Compress and trim videos on your computer. Nothing gets uploaded.

Too big for Discord, Gmail, Outlook, TikTok, X, Bluesky, Instagram, or Threads? Squeeze it.

[Website](https://getsqueeze.app) · [Download](https://github.com/avalianiz/squeeze/releases/latest) · [Report a bug](https://github.com/avalianiz/squeeze/issues)

## Demo

[Watch the demo](docs/demo.mp4)

![demo](docs/demo.gif)

## Features

- Compress videos to a target size
- Trim a start and end before compressing
- Queue a bunch of videos and set each one up on its own
- Preview while you trim
- Auto-update
- Open with Squeeze for mp4, mkv, mov, avi, webm, and m4v
- Windows, macOS, and Linux

## Download

Grab the latest build from the [Releases page](https://github.com/avalianiz/squeeze/releases/latest).

| Platform | File |
|---|---|
| Windows | `.msi` / `.exe` |
| macOS | `.dmg` |
| Linux | `.deb` / AppImage |

Unsigned Windows builds can trip SmartScreen. On macOS you might get an unidentified developer prompt until the app is notarized.

## Build from source

Requires [Node.js](https://nodejs.org), [Rust](https://rustup.rs), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
git clone https://github.com/avalianiz/squeeze.git
cd squeeze
npm install
npm run tauri dev
npm run tauri build
```

## Releasing

Push a `v*` tag, like `v0.3.0`. That builds the installers and the update file.

Signed updates need two GitHub secrets. Don't commit the private key.

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

## Built with

[Tauri](https://tauri.app), Rust, TypeScript, and [FFmpeg](https://ffmpeg.org). FFmpeg has its own license.
