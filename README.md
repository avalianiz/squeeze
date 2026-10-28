<div align="center">

<img src="public/files/favicon.svg" alt="Squeeze logo" width="80" />

# Squeeze

Fit a clip under social media upload limits, or just free up disk space. Nothing is uploaded anywhere.

<br />

[![Release](https://img.shields.io/github/v/release/avalianiz/squeeze?style=flat-square&color=22c3f5)](https://github.com/avalianiz/squeeze/releases)
[![Downloads](https://img.shields.io/github/downloads/avalianiz/squeeze/total?style=flat-square&color=22c3f5)](https://github.com/avalianiz/squeeze/releases)
[![Stars](https://img.shields.io/github/stars/avalianiz/squeeze?style=flat-square&color=22c3f5)](https://github.com/avalianiz/squeeze/stargazers)
[![License](https://img.shields.io/github/license/avalianiz/squeeze?style=flat-square&color=22c3f5)](LICENSE)
![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri-24C8DB?style=flat-square&logo=tauri&logoColor=white)
![Rust](https://shieldcn.dev/badge/Rust.svg?variant=branded&brand=rust)

[**Website**](https://getsqueeze.app) · [**Download**](https://github.com/avalianiz/squeeze/releases/latest) · [**Report a bug**](https://github.com/avalianiz/squeeze/issues) · [**Request a feature**](https://github.com/avalianiz/squeeze/issues)

<br />

[Watch the demo](docs/demo.mp4)

</div>

<br />

## Why Squeeze?

Most "compress video" sites make you upload your files, cap the size, and slap on a watermark. Command-line ffmpeg works great, but you end up doing bitrate math by hand every time.

Squeeze is a small desktop app that wraps ffmpeg. You pick a **target size** and it figures out the rest.

<div align="center">

| | |
|---|---|
| **178.34 MB → 10.00 MB** | A 4K clip, trimmed and compressed to a 10 MB target (−94%) |

</div>

## Features

- **Target-size compression**: pick 10 MB, 25 MB, 50 MB, or enter a custom size
- **Built-in trimmer**: drag the handles on the timeline to cut a clip before encoding
- **Live size estimate**: see the output size and savings before you hit Compress
- **Resolution and framerate controls**: Original / 1080p / 720p, Full / 60 / 30 fps
- **Batch queue**: add multiple videos and process them in one go
- **Mute audio**: strip the audio track in one click
- **Replace originals**: optionally overwrite the source after a successful encode
- **100% local**: your videos never leave your machine
- **Lightweight**: native app built with Rust and Tauri, no bundled browser

## Installation

### Download
![Cross Platform](https://shieldcn.dev/badge/cross-platform-brightgreen.svg?variant=outline&logo=ri%3AGoDeviceDesktop)
Grab the latest installer from the [**Releases**](https://github.com/avalianiz/squeeze/releases/latest) page, or visit [getsqueeze.app](https://getsqueeze.app).

| Platform | File |
|---|---|
| Windows x64 | `Squeeze_*_x64-setup.exe` or `Squeeze_*_x64_en-US.msi` |
| macOS Apple Silicon | `Squeeze_*_aarch64.dmg` |
| macOS Intel | `Squeeze_*_x64.dmg` |
| Linux x64 | `Squeeze_*_amd64.AppImage` or `Squeeze_*_amd64.deb` |

`Squeeze_*.app.tar.gz` on the release is the macOS update payload. Install from the `.dmg`.

Windows may show a SmartScreen “Unknown publisher” warning, and macOS may say the app is from an unidentified developer, until the installers are signed and notarized.

### Build from source

**Prerequisites:** [Node.js](https://nodejs.org) (LTS), [Rust](https://www.rust-lang.org/tools/install), and the [Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS.

```bash
git clone https://github.com/avalianiz/squeeze.git
cd squeeze
npm install
npm run setup:ffmpeg

# run in development
npm run tauri dev

# create a production build
npm run tauri build
```

## Usage

1. **Add videos** by dragging them into the window or clicking *Add videos*.
2. **Trim** (optional) by dragging the timeline handles to the part you want to keep.
3. **Choose settings**: resolution, framerate, and target size.
4. Click **Compress**. The finished file is saved next to the original, or replaces it if you enabled *Replace originals*.

> [!TIP]
> Need it small for a chat app? Start with the 10 MB or 25 MB presets and drop to 720p / 30 fps if the clip is long.

## How it works

Squeeze runs [ffmpeg](https://ffmpeg.org) under the hood. It reads your clip's duration, works out the video bitrate needed to land on your target size, and encodes with those settings. The UI is built with TypeScript and Vite, and the native shell is Rust with [Tauri](https://tauri.app).

## Tech stack

<div align="center">

![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-24C8DB?style=for-the-badge&logo=tauri&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![FFmpeg](https://img.shields.io/badge/FFmpeg-007808?style=for-the-badge&logo=ffmpeg&logoColor=white)

</div>

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request. For larger changes, please open an issue first.

## License

Squeeze's own code is under the [MIT License](LICENSE).

Installers also include FFmpeg and x264, which are GPL-2.0-or-later, and the Manrope font, which is SIL OFL-1.1. The full list is generated into [`NOTICES.txt`](NOTICES.txt) with `npm run notices`.

<div align="center">

<br />

If Squeeze saved you some space, consider leaving a ⭐

Made by [@avalianiz](https://github.com/avalianiz)

</div>
