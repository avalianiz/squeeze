use std::path::{Path, PathBuf};

use crate::error::AppError;

/// Host triple used in Tauri `externalBin` sidecar filenames.
/// Must match the binary names produced by `scripts/ffmpeg/build.sh`.
fn target_triple() -> Option<&'static str> {
    #[cfg(all(windows, target_arch = "x86_64"))]
    {
        Some("x86_64-pc-windows-msvc")
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        Some("x86_64-unknown-linux-gnu")
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        Some("aarch64-apple-darwin")
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        Some("x86_64-apple-darwin")
    }
    #[cfg(not(any(
        all(windows, target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
    )))]
    {
        None
    }
}

fn tool_file_name(tool: &str) -> String {
    #[cfg(windows)]
    {
        format!("{tool}.exe")
    }
    #[cfg(not(windows))]
    {
        tool.to_string()
    }
}

fn sidecar_file_name(tool: &str) -> Option<String> {
    let triple = target_triple()?;
    #[cfg(windows)]
    {
        Some(format!("{tool}-{triple}.exe"))
    }
    #[cfg(not(windows))]
    {
        Some(format!("{tool}-{triple}"))
    }
}

fn first_existing(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|p| p.is_file())
}

fn candidates_in(dir: &Path, tool: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    // Bundled beside the app: Tauri strips the target triple at install time.
    out.push(dir.join(tool_file_name(tool)));
    // Dev / pre-copy: triple-suffixed name from setup / CI artifacts.
    if let Some(sidecar) = sidecar_file_name(tool) {
        out.push(dir.join(sidecar));
    }
    out
}

/// Returns a real on-disk path to a bundled ffmpeg/ffprobe sidecar.
pub fn find(tool: &str) -> Option<PathBuf> {
    if target_triple().is_none() {
        return None;
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(found) = first_existing(candidates_in(dir, tool)) {
                return Some(found);
            }
        }
    }

    let binaries = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    first_existing(candidates_in(&binaries, tool))
}

/// Resolve a bundled sidecar. Never falls back to PATH or downloads.
pub fn resolve(tool: &str) -> Result<PathBuf, AppError> {
    if target_triple().is_none() {
        return Err(AppError::UnsupportedPlatform);
    }

    find(tool).ok_or_else(|| {
        if tool == "ffprobe" {
            AppError::FfprobeNotFound
        } else {
            AppError::FfmpegNotFound
        }
    })
}

/// Confirm both sidecars are present.
/// Dev: run `npm run setup:ffmpeg`. Release installs must ship them via `externalBin`.
pub fn ensure() -> Result<(), AppError> {
    resolve("ffmpeg")?;
    resolve("ffprobe")?;
    Ok(())
}

pub fn hide_console(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}
