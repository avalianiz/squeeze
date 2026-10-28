# Contributing to Squeeze

Issues and pull requests are open. Bug reports and small, focused fixes are the most useful contributions. For a change to behavior, encoding, or the installer, open an issue before you start so it can be scoped before anyone reviews code.

## Reporting bugs and requesting features

Use the issue templates. A report that includes the OS, the Squeeze version, and what the input file was (container, length, resolution — not the file itself) can be reproduced without a long back-and-forth.

## Developing

Requirements: Node.js LTS, Rust, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
git clone https://github.com/avalianiz/squeeze.git
cd squeeze
npm install
npm run setup:ffmpeg
npm run tauri dev
```

`npm run setup:ffmpeg` downloads the prebuilt FFmpeg sidecars. A local production build is `npm run tauri build`.

Do not commit `src-tauri/binaries/`, installer artifacts, `.env` files, or anything under `.keys/`. The updater private key stays in GitHub secrets.

## Dependencies and notices

Third-party licenses are listed in `NOTICES.txt`. That file is generated. After you change `package-lock.json`, `src-tauri/Cargo.lock`, or `scripts/ffmpeg/versions.env`, run:

```bash
npm run notices
```

Commit the updated `NOTICES.txt` with the lockfile change.

## Builds on GitHub

GitHub Actions minutes are limited, so workflows do not run on pushes or pull requests.

- App installers are built only when a `v*` tag is pushed (or when the Release workflow is run by hand from that tag).
- FFmpeg sidecars are built only when someone runs the Build FFmpeg sidecars workflow by hand. Run it when `scripts/ffmpeg/` changes, then use the new `ffmpeg-sidecars-*` release from `npm run setup:ffmpeg`.

Don't push a `v*` tag to try a build. That spends a full Windows, Linux, and macOS matrix.

## License

Your contributions are licensed under the MIT License that covers Squeeze's own code. The bundled FFmpeg and x264 binaries remain under the GPL. See `LICENSE` and `NOTICES.txt`.
