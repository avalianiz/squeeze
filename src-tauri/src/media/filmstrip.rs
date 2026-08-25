use std::path::{Path, PathBuf};
use std::process::Stdio;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tokio::process::Command;

use crate::error::AppError;
use crate::media::binaries;
use crate::media::ffprobe;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilmstripResult {
    /// data:image/jpeg;base64,... URLs so the UI does not depend on asset-protocol temp paths
    pub frames: Vec<String>,
}

fn cache_dir(path: &Path) -> PathBuf {
    let key = {
        let meta = std::fs::metadata(path).ok();
        let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let modified = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!(
            "{:x}-{}-{}",
            simple_hash(&path.display().to_string()),
            len,
            modified
        )
    };
    std::env::temp_dir().join("squeeze-filmstrip").join(key)
}

fn simple_hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

pub async fn extract(path: &Path, count: u32) -> Result<FilmstripResult, AppError> {
    if !path.exists() {
        return Err(AppError::InputNotFound(path.display().to_string()));
    }

    let count = count.clamp(4, 16);
    let dir = cache_dir(path);
    let marker = dir.join(format!(".ok-{count}"));

    if marker.exists() {
        let mut frames = collect_frame_data_urls(&dir);
        if frames.len() as u32 >= count.saturating_sub(1) && !frames.is_empty() {
            frames.truncate(count as usize);
            return Ok(FilmstripResult { frames });
        }
    }

    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Io(format!("couldn't create filmstrip cache: {e}")))?;

    let media = ffprobe::probe(path).await?;
    let duration = media.duration_seconds.max(0.1);
    let fps = (count as f64 / duration).max(0.01);

    // FFmpeg image2 patterns break on Windows backslashes — force forward slashes.
    let pattern = dir.join("frame_%02d.jpg");
    let pattern_arg = pattern.to_string_lossy().replace('\\', "/");
    let input_arg = path.to_string_lossy().replace('\\', "/");
    let ffmpeg = binaries::resolve("ffmpeg")?;
    let mut cmd = Command::new(&ffmpeg);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        &input_arg,
        "-vf",
        &format!("fps={fps:.6},scale=160:-2"),
        "-frames:v",
        &count.to_string(),
        "-q:v",
        "5",
        &pattern_arg,
    ]);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());
    binaries::hide_console(&mut cmd);

    let output = cmd
        .output()
        .await
        .map_err(|e| AppError::EncodingFailed(e.to_string()))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::EncodingFailed(if err.trim().is_empty() {
            "filmstrip extract failed".to_string()
        } else {
            err.trim().chars().take(240).collect()
        }));
    }

    let frames = collect_frame_data_urls(&dir);
    if frames.is_empty() {
        return Err(AppError::EncodingFailed(
            "filmstrip produced no frames".to_string(),
        ));
    }

    let _ = std::fs::write(&marker, b"ok");
    Ok(FilmstripResult { frames })
}

fn collect_frame_paths(dir: &Path) -> Vec<PathBuf> {
    let mut frames: Vec<_> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("jpg"))
        })
        .map(|entry| entry.path())
        .collect();
    frames.sort();
    frames
}

fn to_data_url(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:image/jpeg;base64,{encoded}"))
}

fn collect_frame_data_urls(dir: &Path) -> Vec<String> {
    collect_frame_paths(dir)
        .into_iter()
        .filter_map(|p| to_data_url(&p))
        .collect()
}
