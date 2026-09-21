# Squeeze

Local desktop app that compresses (and optionally trims) videos for Discord-sized uploads. Built with Tauri 2 + React.

## Dev

```bash
npm install
npm run tauri dev
```

Put `ffmpeg.exe` and `ffprobe.exe` in `src-tauri/binaries/` (gitignored).

## Package (Windows)

```bash
npm run tauri build
```

Installer / binaries land under `src-tauri/target/release/bundle/`.
