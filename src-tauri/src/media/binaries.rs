use std::io::copy;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::error::AppError;

static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();
static TOOLS_DIR: OnceLock<PathBuf> = OnceLock::new();
static ENSURE_LOCK: Mutex<()> = Mutex::const_new(());

const ESSENTIALS_ZIP_URL: &str =
    "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

/// Remember the packaged resource dir so ffmpeg/ffprobe resolve after install.
pub fn set_resource_dir(dir: PathBuf) {
    let _ = RESOURCE_DIR.set(dir);
}

pub fn set_tools_dir(dir: PathBuf) {
    let _ = TOOLS_DIR.set(dir);
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

fn first_existing(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|p| p.is_file())
}

fn candidates_in(dir: &Path, file_name: &str) -> Vec<PathBuf> {
    vec![
        dir.join(file_name),
        dir.join("binaries").join(file_name),
        dir.join("resources").join("binaries").join(file_name),
        dir.join("bin").join(file_name),
    ]
}

/// Returns a real on-disk tool path when we know where it lives.
pub fn find(tool: &str) -> Option<PathBuf> {
    let file_name = tool_file_name(tool);

    if let Some(dir) = TOOLS_DIR.get() {
        if let Some(found) = first_existing(candidates_in(dir, &file_name)) {
            return Some(found);
        }
    }

    if let Some(dir) = RESOURCE_DIR.get() {
        if let Some(found) = first_existing(candidates_in(dir, &file_name)) {
            return Some(found);
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(found) = first_existing(candidates_in(dir, &file_name)) {
                return Some(found);
            }
        }
    }

    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(&file_name);
    if dev.is_file() {
        return Some(dev);
    }

    None
}

// Prefer cached tools / resources / next-to-exe / local binaries, then PATH.
pub fn resolve(tool: &str) -> Result<PathBuf, AppError> {
    if let Some(found) = find(tool) {
        return Ok(found);
    }
    Ok(PathBuf::from(tool_file_name(tool)))
}

fn tools_ready() -> bool {
    find("ffmpeg").is_some() && find("ffprobe").is_some()
}

fn emit_status(app: &AppHandle, message: &str) {
    let _ = app.emit("tools-status", message);
}

/// Make sure ffmpeg + ffprobe exist. Downloads a compact essentials build once if needed.
pub async fn ensure(app: &AppHandle) -> Result<(), AppError> {
    if tools_ready() {
        return Ok(());
    }

    let tools_dir = TOOLS_DIR.get().cloned().ok_or_else(|| {
        AppError::ToolsDownloadFailed("tools folder is not configured".to_string())
    })?;

    // Serialize downloads (probe + worker might race on first run).
    let _guard = ENSURE_LOCK.lock().await;

    if tools_ready() {
        return Ok(());
    }

    emit_status(app, "Downloading FFmpeg (one-time, ~80 MB)…");

    let result = tauri::async_runtime::spawn_blocking(move || download_essentials(&tools_dir))
        .await
        .map_err(|err| AppError::ToolsDownloadFailed(format!("download task failed: {err}")))?;

    match result {
        Ok(()) => {
            emit_status(app, "");
            Ok(())
        }
        Err(err) => {
            emit_status(app, "");
            Err(err)
        }
    }
}

fn download_essentials(tools_dir: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(tools_dir).map_err(|err| {
        AppError::ToolsDownloadFailed(format!("couldnt create tools folder: {err}"))
    })?;

    let response = ureq::get(ESSENTIALS_ZIP_URL)
        .call()
        .map_err(|err| AppError::ToolsDownloadFailed(format!("download failed: {err}")))?;

    let mut reader = response.into_body().into_reader();
    let zip_path = tools_dir.join("ffmpeg-essentials.zip");
    {
        let mut file = std::fs::File::create(&zip_path).map_err(|err| {
            AppError::ToolsDownloadFailed(format!("couldnt save download: {err}"))
        })?;
        copy(&mut reader, &mut file).map_err(|err| {
            AppError::ToolsDownloadFailed(format!("couldnt write download: {err}"))
        })?;
    }

    extract_tools(&zip_path, tools_dir)?;
    let _ = std::fs::remove_file(&zip_path);

    let ffmpeg = tools_dir.join(tool_file_name("ffmpeg"));
    let ffprobe = tools_dir.join(tool_file_name("ffprobe"));
    if !ffmpeg.is_file() || !ffprobe.is_file() {
        return Err(AppError::ToolsDownloadFailed(
            "download finished but ffmpeg/ffprobe were missing from the zip".to_string(),
        ));
    }

    Ok(())
}

fn extract_tools(zip_path: &Path, tools_dir: &Path) -> Result<(), AppError> {
    let file = std::fs::File::open(zip_path).map_err(|err| {
        AppError::ToolsDownloadFailed(format!("couldnt open download: {err}"))
    })?;
    let mut archive = zip::ZipArchive::new(file).map_err(|err| {
        AppError::ToolsDownloadFailed(format!("couldnt read zip: {err}"))
    })?;

    let mut wrote_ffmpeg = false;
    let mut wrote_ffprobe = false;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|err| {
            AppError::ToolsDownloadFailed(format!("bad zip entry: {err}"))
        })?;
        let name = entry.name().replace('\\', "/");
        let dest_name = if name.ends_with("/bin/ffmpeg.exe") || name == "bin/ffmpeg.exe" {
            Some(tool_file_name("ffmpeg"))
        } else if name.ends_with("/bin/ffprobe.exe") || name == "bin/ffprobe.exe" {
            Some(tool_file_name("ffprobe"))
        } else {
            None
        };

        let Some(dest_name) = dest_name else {
            continue;
        };

        let out_path = tools_dir.join(&dest_name);
        let mut out = std::fs::File::create(&out_path).map_err(|err| {
            AppError::ToolsDownloadFailed(format!("couldnt extract {dest_name}: {err}"))
        })?;
        copy(&mut entry, &mut out).map_err(|err| {
            AppError::ToolsDownloadFailed(format!("couldnt write {dest_name}: {err}"))
        })?;

        if dest_name.starts_with("ffmpeg") {
            wrote_ffmpeg = true;
        } else {
            wrote_ffprobe = true;
        }
    }

    if !wrote_ffmpeg || !wrote_ffprobe {
        return Err(AppError::ToolsDownloadFailed(
            "essentials zip did not contain ffmpeg and ffprobe".to_string(),
        ));
    }

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
