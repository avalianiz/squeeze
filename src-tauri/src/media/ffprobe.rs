use std::path::{Path, PathBuf};

use serde::Deserialize;
use tokio::process::Command;

use crate::error::AppError;
use crate::models::Media;

/// Run ffprobe on a file and turn the JSON into our Media struct.
///
/// We spawn ffprobe as a real process with an arg list (never a shell string)
/// so paths with spaces don't break and nobody can inject extra flags.
pub async fn probe(path: &Path) -> Result<Media, AppError> {
    if !path.exists() {
        return Err(AppError::InputNotFound(path.display().to_string()));
    }

    let ffprobe = resolve_ffprobe()?;
    let mut cmd = Command::new(&ffprobe);
    cmd.args([
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
    ]);
    cmd.arg(path);

    // Don't flash a console window on Windows when we spawn ffprobe.
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().await.map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            AppError::FfprobeNotFound
        } else {
            AppError::FfprobeFailed(err.to_string())
        }
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let message = stderr.trim();
        return Err(AppError::FfprobeFailed(if message.is_empty() {
            format!("exited with {}", output.status)
        } else {
            message.to_string()
        }));
    }

    let parsed: FfprobeJson = serde_json::from_slice(&output.stdout).map_err(|err| {
        AppError::FfprobeFailed(format!("couldnt parse ffprobe json: {err}"))
    })?;

    media_from_probe(path, parsed)
}

fn resolve_ffprobe() -> Result<PathBuf, AppError> {
    #[cfg(windows)]
    let name = "ffprobe.exe";
    #[cfg(not(windows))]
    let name = "ffprobe";

    // Dev-time: src-tauri/binaries/ffprobe.exe next to Cargo.toml
    let bundled = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(name);
    if bundled.exists() {
        return Ok(bundled);
    }

    // Fall back to PATH (whatever `where ffprobe` would find)
    Ok(PathBuf::from(name))
}

fn media_from_probe(path: &Path, probe: FfprobeJson) -> Result<Media, AppError> {
    let video = probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("video"));

    if video.is_none() {
        return Err(AppError::InvalidVideo(
            "no video stream in this file".to_string(),
        ));
    }

    let audio = probe
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("audio"));

    let duration_seconds = probe
        .format
        .as_ref()
        .and_then(|format| format.duration.as_ref())
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|duration| *duration > 0.0)
        .ok_or_else(|| AppError::InvalidVideo("missing duration".to_string()))?;

    let size_bytes = std::fs::metadata(path)
        .map(|meta| meta.len())
        .or_else(|_| {
            probe
                .format
                .as_ref()
                .and_then(|format| format.size.as_ref())
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or(())
        })
        .map_err(|_| AppError::InvalidVideo("missing file size".to_string()))?;

    Ok(Media {
        path: path.display().to_string(),
        duration_seconds,
        size_bytes,
        width: video.and_then(|stream| stream.width),
        height: video.and_then(|stream| stream.height),
        frame_rate: video.and_then(|stream| {
            stream
                .avg_frame_rate
                .as_deref()
                .or(stream.r_frame_rate.as_deref())
                .and_then(parse_frame_rate)
        }),
        video_codec: video.and_then(|stream| stream.codec_name.clone()),
        audio_codec: audio.and_then(|stream| stream.codec_name.clone()),
    })
}

fn parse_frame_rate(value: &str) -> Option<f64> {
    let mut parts = value.split('/');
    let num: f64 = parts.next()?.parse().ok()?;
    let den: f64 = match parts.next() {
        Some(den) => den.parse().ok()?,
        None => 1.0,
    };
    if den == 0.0 {
        None
    } else {
        Some(num / den)
    }
}

// Only the ffprobe JSON fields we actually use.
#[derive(Debug, Deserialize)]
struct FfprobeJson {
    #[serde(default)]
    streams: Vec<FfprobeStream>,
    format: Option<FfprobeFormat>,
}

#[derive(Debug, Deserialize)]
struct FfprobeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FfprobeFormat {
    duration: Option<String>,
    size: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_rate_fraction() {
        assert_eq!(parse_frame_rate("30/1"), Some(30.0));
        let ntsc = parse_frame_rate("30000/1001").expect("ntsc fps");
        assert!((ntsc - 29.97).abs() < 0.01);
        assert_eq!(parse_frame_rate("0/0"), None);
    }
}
