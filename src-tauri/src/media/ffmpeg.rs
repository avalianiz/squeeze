use std::io;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::error::AppError;
use crate::filesystem::output::{
    backup_path, beside_original_unique, replace_final_path, temp_path,
};
use crate::media::binaries;
use crate::media::bitrate::{plan_bitrates, scale_video_bitrate, BitratePlan};
use crate::media::ffprobe;
use crate::models::{CompressResult, CompressionSettings, JobKind, OutputMode, TrimRange, VideoCodec};

// old one-shot path the ui used before the queue existed
pub async fn compress(
    path: &Path,
    settings: &CompressionSettings,
) -> Result<CompressResult, AppError> {
    run_job(
        path,
        settings,
        OutputMode::CopyBeside,
        None,
        None,
        JobKind::Squeeze,
        Arc::new(AtomicBool::new(false)),
        |_, _, _| {},
    )
    .await
}

// queue calls this so we can cancel + drip progress back out
pub async fn run_job<F>(
    path: &Path,
    settings: &CompressionSettings,
    output_mode: OutputMode,
    trim: Option<TrimRange>,
    output_name: Option<String>,
    kind: JobKind,
    cancel: Arc<AtomicBool>,
    on_progress: F,
) -> Result<CompressResult, AppError>
where
    F: Fn(f64, f64, f64) + Send + Sync,
{
    match kind {
        JobKind::Squeeze => {
            compress_job(
                path,
                settings,
                output_mode,
                trim,
                output_name.as_deref(),
                cancel,
                on_progress,
            )
            .await
        }
        JobKind::Trim => {
            trim_job(
                path,
                output_mode,
                trim,
                output_name.as_deref(),
                cancel,
                on_progress,
            )
            .await
        }
    }
}

async fn compress_job<F>(
    path: &Path,
    settings: &CompressionSettings,
    output_mode: OutputMode,
    trim: Option<TrimRange>,
    output_name: Option<&str>,
    cancel: Arc<AtomicBool>,
    on_progress: F,
) -> Result<CompressResult, AppError>
where
    F: Fn(f64, f64, f64) + Send + Sync,
{
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Cancelled);
    }

    if !path.exists() {
        return Err(AppError::InputNotFound(path.display().to_string()));
    }

    let media = ffprobe::probe(path).await?;

    if let Some(ref range) = trim {
        range.validate(media.duration_seconds)?;
    }

    let active_trim = trim
        .as_ref()
        .filter(|range| !range.covers_whole(media.duration_seconds));

    let encode_duration = match active_trim {
        Some(range) => range.duration(),
        None => media.duration_seconds,
    };

    let needs_trim = active_trim.is_some();

    // already small enough and they didnt ask to cut anything
    if media.size_bytes <= settings.target_size_bytes && !needs_trim {
        on_progress(encode_duration, encode_duration, 100.0);
        return Ok(CompressResult {
            output_path: media.path,
            output_size_bytes: media.size_bytes,
            skipped: true,
        });
    }

    let plan = plan_bitrates(encode_duration, settings)?;
    let temp = temp_path(path);

    encode_to(
        path,
        &temp,
        settings,
        &plan,
        encode_duration,
        active_trim,
        cancel.clone(),
        &on_progress,
    )
    .await?;

    let mut size = std::fs::metadata(&temp)
        .map(|m| m.len())
        .map_err(|e| AppError::EncodingFailed(e.to_string()))?;

    if size > settings.target_size_bytes {
        if cancel.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(&temp);
            return Err(AppError::Cancelled);
        }
        let _ = std::fs::remove_file(&temp);
        let retry = scale_video_bitrate(&plan, 0.85);
        encode_to(
            path,
            &temp,
            settings,
            &retry,
            encode_duration,
            active_trim,
            cancel.clone(),
            &on_progress,
        )
        .await?;
        size = std::fs::metadata(&temp)
            .map(|m| m.len())
            .map_err(|e| AppError::EncodingFailed(e.to_string()))?;
    }

    if cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&temp);
        return Err(AppError::Cancelled);
    }

    if size > settings.target_size_bytes {
        let _ = std::fs::remove_file(&temp);
        return Err(AppError::EncodingFailed(format!(
            "still {} bytes after retry, target was {}",
            size, settings.target_size_bytes
        )));
    }

    let final_out = finalize_output(path, &temp, output_mode, output_name, "-squeezed")?;

    on_progress(encode_duration, encode_duration, 100.0);

    Ok(CompressResult {
        output_path: final_out.display().to_string(),
        output_size_bytes: size,
        skipped: false,
    })
}

async fn trim_job<F>(
    path: &Path,
    output_mode: OutputMode,
    trim: Option<TrimRange>,
    output_name: Option<&str>,
    cancel: Arc<AtomicBool>,
    on_progress: F,
) -> Result<CompressResult, AppError>
where
    F: Fn(f64, f64, f64) + Send + Sync,
{
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Cancelled);
    }

    if !path.exists() {
        return Err(AppError::InputNotFound(path.display().to_string()));
    }

    let media = ffprobe::probe(path).await?;
    let range = trim.ok_or(AppError::InvalidTrimRange)?;
    range.validate(media.duration_seconds)?;

    if range.covers_whole(media.duration_seconds) {
        return Err(AppError::EncodingFailed(
            "move the trim handles before trimming".to_string(),
        ));
    }

    let duration = range.duration();
    let temp = temp_path(path);

    copy_trim_to(
        path,
        &temp,
        &range,
        duration,
        cancel.clone(),
        &on_progress,
    )
    .await?;

    if cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(&temp);
        return Err(AppError::Cancelled);
    }

    let size = std::fs::metadata(&temp)
        .map(|m| m.len())
        .map_err(|e| AppError::EncodingFailed(e.to_string()))?;

    let final_out = finalize_output(path, &temp, output_mode, output_name, "-trimmed")?;

    on_progress(duration, duration, 100.0);

    Ok(CompressResult {
        output_path: final_out.display().to_string(),
        output_size_bytes: size,
        skipped: false,
    })
}

fn finalize_output(
    path: &Path,
    temp: &Path,
    output_mode: OutputMode,
    output_name: Option<&str>,
    suffix: &str,
) -> Result<std::path::PathBuf, AppError> {
    match output_mode {
        OutputMode::CopyBeside => {
            let dest = beside_original_unique(path, output_name, suffix);
            std::fs::rename(temp, &dest).map_err(|e| {
                let _ = std::fs::remove_file(temp);
                AppError::EncodingFailed(e.to_string())
            })?;
            Ok(dest)
        }
        OutputMode::Replace => finalize_replace(path, temp, output_name),
    }
}

// never overwrite the original until the temp file is good
fn finalize_replace(
    original: &Path,
    temp: &Path,
    output_name: Option<&str>,
) -> Result<std::path::PathBuf, AppError> {
    let final_path = replace_final_path(original, output_name);
    let backup = backup_path(original);

    if backup.exists() {
        let _ = std::fs::remove_file(&temp);
        return Err(AppError::OutputAlreadyExists(backup.display().to_string()));
    }

    // same path (already .mp4): move original aside, then slide temp into place
    if final_path == original {
        std::fs::rename(original, &backup).map_err(|e| {
            let _ = std::fs::remove_file(temp);
            AppError::EncodingFailed(e.to_string())
        })?;

        if let Err(e) = std::fs::rename(temp, &final_path) {
            let _ = std::fs::rename(&backup, original);
            let _ = std::fs::remove_file(temp);
            return Err(AppError::EncodingFailed(e.to_string()));
        }

        let _ = std::fs::remove_file(&backup);
        return Ok(final_path);
    }

    // different ext (eg .mkv -> .mp4): park original, put mp4 down, then drop backup
    if final_path.exists() {
        let _ = std::fs::remove_file(temp);
        return Err(AppError::OutputAlreadyExists(
            final_path.display().to_string(),
        ));
    }

    std::fs::rename(original, &backup).map_err(|e| {
        let _ = std::fs::remove_file(temp);
        AppError::EncodingFailed(e.to_string())
    })?;

    if let Err(e) = std::fs::rename(temp, &final_path) {
        let _ = std::fs::rename(&backup, original);
        let _ = std::fs::remove_file(temp);
        return Err(AppError::EncodingFailed(e.to_string()));
    }

    let _ = std::fs::remove_file(&backup);
    Ok(final_path)
}

async fn copy_trim_to<F>(
    input: &Path,
    output: &Path,
    trim: &TrimRange,
    duration_seconds: f64,
    cancel: Arc<AtomicBool>,
    on_progress: &F,
) -> Result<(), AppError>
where
    F: Fn(f64, f64, f64) + Send + Sync,
{
    let ffmpeg = binaries::resolve("ffmpeg").map_err(|_| AppError::FfmpegNotFound)?;

    if output.exists() {
        let _ = std::fs::remove_file(output);
    }

    // -ss before -i for a fast stream-copy cut (keyframe-aligned).
    let args = [
        "-y".to_string(),
        "-ss".to_string(),
        format!("{:.3}", trim.start_seconds),
        "-i".to_string(),
        input.display().to_string(),
        "-t".to_string(),
        format!("{:.3}", trim.duration()),
        "-map".to_string(),
        "0".to_string(),
        "-c".to_string(),
        "copy".to_string(),
        "-avoid_negative_ts".to_string(),
        "make_zero".to_string(),
        "-nostats".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
        output.display().to_string(),
    ];

    let mut cmd = Command::new(&ffmpeg);
    cmd.args(&args);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    binaries::hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|err| {
        if err.kind() == io::ErrorKind::NotFound {
            AppError::FfmpegNotFound
        } else {
            AppError::EncodingFailed(err.to_string())
        }
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::EncodingFailed("missing ffmpeg stdout".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::EncodingFailed("missing ffmpeg stderr".to_string()))?;

    let stderr_task = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut tail = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if tail.len() > 2000 {
                tail.clear();
            }
            tail.push_str(&line);
            tail.push('\n');
        }
        tail
    });

    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            let _ = std::fs::remove_file(output);
            return Err(AppError::Cancelled);
        }

        if let Some(elapsed) = parse_out_time_seconds(&line) {
            let pct = if duration_seconds > 0.0 {
                ((elapsed / duration_seconds) * 100.0).clamp(0.0, 99.0)
            } else {
                0.0
            };
            on_progress(elapsed, duration_seconds, pct);
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| AppError::EncodingFailed(e.to_string()))?;

    let stderr_tail = stderr_task.await.unwrap_or_default();

    if cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(output);
        return Err(AppError::Cancelled);
    }

    if !status.success() {
        let _ = std::fs::remove_file(output);
        let msg = stderr_tail.trim();
        return Err(AppError::EncodingFailed(if msg.is_empty() {
            format!("trim failed with {status}")
        } else {
            msg.chars()
                .rev()
                .take(400)
                .collect::<String>()
                .chars()
                .rev()
                .collect()
        }));
    }

    Ok(())
}

async fn encode_to<F>(
    input: &Path,
    output: &Path,
    settings: &CompressionSettings,
    plan: &BitratePlan,
    duration_seconds: f64,
    trim: Option<&TrimRange>,
    cancel: Arc<AtomicBool>,
    on_progress: &F,
) -> Result<(), AppError>
where
    F: Fn(f64, f64, f64) + Send + Sync,
{
    let ffmpeg = binaries::resolve("ffmpeg").map_err(|_| AppError::FfmpegNotFound)?;

    if output.exists() {
        let _ = std::fs::remove_file(output);
    }

    let video_b = plan.video_bitrate_bps.to_string();
    let audio_b = plan.audio_bitrate_bps.to_string();
    let codec = match settings.video_codec {
        VideoCodec::H264 => "libx264",
    };

    // -i first, then -ss/-t so the cut is accurate while we re-encode anyway
    let mut args = vec![
        "-y".to_string(),
        "-i".to_string(),
        input.display().to_string(),
    ];

    if let Some(range) = trim {
        args.push("-ss".to_string());
        args.push(format!("{:.3}", range.start_seconds));
        args.push("-t".to_string());
        args.push(format!("{:.3}", range.duration()));
    }

    args.extend([
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
        "-nostats".to_string(),
        "-progress".to_string(),
        "pipe:1".to_string(),
    ]);

    let mut filters: Vec<String> = Vec::new();
    if let (Some(w), Some(h)) = (settings.max_width, settings.max_height) {
        filters.push(format!(
            "scale='min({w},iw)':'min({h},ih)':force_original_aspect_ratio=decrease"
        ));
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
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    binaries::hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|err| {
        if err.kind() == io::ErrorKind::NotFound {
            AppError::FfmpegNotFound
        } else {
            AppError::EncodingFailed(err.to_string())
        }
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::EncodingFailed("missing ffmpeg stdout".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::EncodingFailed("missing ffmpeg stderr".to_string()))?;

    // drain stderr so the pipe doesnt fill up and freeze ffmpeg
    let stderr_task = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut tail = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if tail.len() > 2000 {
                tail.clear();
            }
            tail.push_str(&line);
            tail.push('\n');
        }
        tail
    });

    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill().await;
            let _ = std::fs::remove_file(output);
            return Err(AppError::Cancelled);
        }

        if let Some(elapsed) = parse_out_time_seconds(&line) {
            let pct = if duration_seconds > 0.0 {
                ((elapsed / duration_seconds) * 100.0).clamp(0.0, 99.0)
            } else {
                0.0
            };
            on_progress(elapsed, duration_seconds, pct);
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| AppError::EncodingFailed(e.to_string()))?;

    let stderr_tail = stderr_task.await.unwrap_or_default();

    if cancel.load(Ordering::SeqCst) {
        let _ = std::fs::remove_file(output);
        return Err(AppError::Cancelled);
    }

    if !status.success() {
        let _ = std::fs::remove_file(output);
        let msg = stderr_tail.trim();
        return Err(AppError::EncodingFailed(if msg.is_empty() {
            format!("exited with {status}")
        } else {
            msg.chars()
                .rev()
                .take(400)
                .collect::<String>()
                .chars()
                .rev()
                .collect()
        }));
    }

    Ok(())
}

// ffmpeg prints out_time_ms=... (actually microseconds half the time, go figure)
fn parse_out_time_seconds(line: &str) -> Option<f64> {
    if let Some(value) = line.strip_prefix("out_time_ms=") {
        let us: f64 = value.parse().ok()?;
        return Some(us / 1_000_000.0);
    }
    if let Some(value) = line.strip_prefix("out_time_us=") {
        let us: f64 = value.parse().ok()?;
        return Some(us / 1_000_000.0);
    }
    if let Some(value) = line.strip_prefix("out_time=") {
        // HH:MM:SS.micro
        return parse_hms(value);
    }
    None
}

fn parse_hms(value: &str) -> Option<f64> {
    let mut parts = value.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}
