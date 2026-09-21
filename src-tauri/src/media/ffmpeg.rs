use std::path::Path;

use tokio::process::Command;

use crate::error::AppError;
use crate::filesystem::output::{beside_original, temp_path};
use crate::media::binaries;
use crate::media::bitrate::{plan_bitrates, scale_video_bitrate, BitratePlan};
use crate::media::ffprobe;
use crate::models::{CompressResult, CompressionSettings, VideoCodec};


pub async fn compress(path: &Path, settings: &CompressionSettings) -> Result<CompressResult, AppError> {
    if !path.exists() {
        return Err(AppError::InputNotFound(path.display().to_string()));
    }

    let media = ffprobe::probe(path).await?;

    // already small enough for discord so dont waste anymore time
    if media.size_bytes <= settings.target_size_bytes {
        return Ok(CompressResult {
            output_path: media.path,
            output_size_bytes: media.size_bytes,
            skipped: true,
        });
    }

    let plan = plan_bitrates(media.duration_seconds, settings)?;
    let temp = temp_path(path);
    let final_out = beside_original(path);

    if final_out.exists() {
        return Err(AppError::OutputAlreadyExists(final_out.display().to_string()));
    }

    // first try, then one retry a bit lower if ffmpeg overshoots
    encode_to(path, &temp, settings, &plan).await?;
    let mut size = std::fs::metadata(&temp)
        .map(|m| m.len())
        .map_err(|e| AppError::EncodingFailed(e.to_string()))?;

    if size > settings.target_size_bytes {
        let _ = std::fs::remove_file(&temp);
        let retry = scale_video_bitrate(&plan, 0.85);
        encode_to(path, &temp, settings, &retry).await?;
        size = std::fs::metadata(&temp)
            .map(|m| m.len())
            .map_err(|e| AppError::EncodingFailed(e.to_string()))?;
    }

    if size > settings.target_size_bytes {
        let _ = std::fs::remove_file(&temp);
        return Err(AppError::EncodingFailed(format!(
            "still {} bytes after retry, target was {}",
            size, settings.target_size_bytes
        )));
    }

    std::fs::rename(&temp, &final_out).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        AppError::EncodingFailed(e.to_string())
    })?;

    Ok(CompressResult {
        output_path: final_out.display().to_string(),
        output_size_bytes: size,
        skipped: false,
    })
}

async fn encode_to(
    input: &Path,
    output: &Path,
    settings: &CompressionSettings,
    plan: &BitratePlan,
) -> Result<(), AppError> {
    let ffmpeg = binaries::resolve("ffmpeg").map_err(|_| AppError::FfmpegNotFound)?;

    // wipe leftover temp from a crashed run
    if output.exists() {
        let _ = std::fs::remove_file(output);
    }

    let video_b = format!("{}", plan.video_bitrate_bps);
    let audio_b = format!("{}", plan.audio_bitrate_bps);
    let codec = match settings.video_codec {
        VideoCodec::H264 => "libx264",
    };

    let mut args = vec![
        "-y".to_string(),
        "-i".to_string(),
        input.display().to_string(),
        "-map".to_string(),
        "0:v:0".to_string(),
        "-map".to_string(),
        "0:a?".to_string(),
        "-c:v".to_string(),
        codec.to_string(),
        "-b:v".to_string(),
        video_b,
        "-maxrate".to_string(),
        plan.video_bitrate_bps.to_string(),
        "-bufsize".to_string(),
        (plan.video_bitrate_bps * 2).to_string(),
        "-c:a".to_string(),
        "aac".to_string(),
        "-b:a".to_string(),
        audio_b,
        "-movflags".to_string(),
        "+faststart".to_string(),
    ];

    // optional downscale / fps caps from settings
    let mut filters: Vec<String> = Vec::new();
    if let (Some(w), Some(h)) = (settings.max_width, settings.max_height) {
        filters.push(format!("scale='min({w},iw)':'min({h},ih)':force_original_aspect_ratio=decrease"));
    } else if let Some(w) = settings.max_width {
        filters.push(format!("scale='min({w},iw)':-2"));
    } else if let Some(h) = settings.max_height {
        filters.push(format!("scale=-2:'min({h},ih)'"));
    }
    if let Some(fps) = settings.max_fps {
        filters.push(format!("fps={fps}"));
    }
    if !filters.is_empty() {
        args.push("-vf".to_string());
        args.push(filters.join(","));
    }

    args.push(output.display().to_string());

    let mut cmd = Command::new(&ffmpeg);
    cmd.args(&args);
    binaries::hide_console(&mut cmd);

    let out = cmd.output().await.map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            AppError::FfmpegNotFound
        } else {
            AppError::EncodingFailed(err.to_string())
        }
    })?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let msg = stderr.trim();
        let _ = std::fs::remove_file(output);
        return Err(AppError::EncodingFailed(if msg.is_empty() {
            format!("exited with {}", out.status)
        } else {
            // ffmpeg dumps a lot, keep the tail so the ui isnt insane
            let short: String = msg
                .chars()
                .rev()
                .take(400)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            short
        }));
    }

    Ok(())
}
