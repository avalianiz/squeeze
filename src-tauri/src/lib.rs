mod error;
mod filesystem;
mod jobs;
mod media;
mod models;

use std::path::Path;
use std::sync::{Arc, Mutex};

use error::AppError;
use filesystem::discovery;
use filesystem::output::sanitize_stem;
use jobs::state::JobManager;
use jobs::worker;
use media::filmstrip::FilmstripResult;
use models::{
    CompressionJob, CompressionSettings, DropIngestResult, JobKind, JobSettingsInput, Media,
    OutputMode, PlanPreview, TrimRange,
};
use tauri::{AppHandle, Emitter, Manager, State};

fn output_mode(replace: bool) -> OutputMode {
    if replace {
        OutputMode::Replace
    } else {
        OutputMode::CopyBeside
    }
}

fn clean_output_name(name: Option<String>) -> Option<String> {
    name.map(|n| sanitize_stem(&n)).filter(|n| !n.is_empty())
}

#[derive(Default)]
struct PendingOpens(Mutex<Vec<String>>);

fn is_openable_video(path: &Path) -> bool {
    // Explicit opens (Explorer, Open with, command line) should load the file
    // even when the name looks like a previous Squeeze output.
    path.is_file() && discovery::has_video_extension(path)
}

fn launch_arg_candidates(arg: &str) -> Vec<String> {
    let trimmed = arg.trim();
    let mut found = Vec::new();
    if trimmed.is_empty() {
        return found;
    }

    let unquoted = trimmed.trim_matches('"').trim();
    if !unquoted.is_empty() {
        found.push(unquoted.to_string());
    }

    let mut rest = trimmed;
    while let Some(start) = rest.find('"') {
        let after = &rest[start + 1..];
        if let Some(end) = after.find('"') {
            let inner = after[..end].trim();
            if !inner.is_empty() {
                found.push(inner.to_string());
            }
            rest = &after[end + 1..];
        } else {
            break;
        }
    }

    found
}

fn collect_video_args(args: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for arg in args {
        for candidate in launch_arg_candidates(&arg) {
            if candidate.starts_with('-') {
                continue;
            }
            if !is_openable_video(Path::new(&candidate)) {
                continue;
            }
            if paths
                .iter()
                .any(|existing| discovery::same_path(existing, &candidate))
            {
                continue;
            }
            paths.push(candidate);
        }
    }
    paths
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn enqueue_open_paths(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<PendingOpens>() {
        if let Ok(mut queued) = state.0.lock() {
            for path in &paths {
                if !queued
                    .iter()
                    .any(|existing| discovery::same_path(existing, path))
                {
                    queued.push(path.clone());
                }
            }
        }
    }
    let _ = app.emit("open-paths", &paths);
}

#[tauri::command]
async fn probe_media(path: String) -> Result<Media, AppError> {
    media::binaries::ensure()?;
    media::ffprobe::probe(Path::new(&path)).await
}

#[tauri::command]
async fn preview_plan(
    duration_seconds: f64,
    settings: JobSettingsInput,
) -> Result<PlanPreview, AppError> {
    Ok(media::bitrate::preview_plan(
        duration_seconds,
        &CompressionSettings::from_input(&settings),
    ))
}

#[tauri::command]
async fn extract_filmstrip(path: String, count: Option<u32>) -> Result<FilmstripResult, AppError> {
    media::binaries::ensure()?;
    media::filmstrip::extract(Path::new(&path), count.unwrap_or(10)).await
}

#[tauri::command]
async fn enqueue_job(
    path: String,
    replace: bool,
    trim: Option<TrimRange>,
    kind: JobKind,
    output_name: Option<String>,
    settings: JobSettingsInput,
    manager: State<'_, Arc<JobManager>>,
) -> Result<CompressionJob, AppError> {
    if !Path::new(&path).exists() {
        return Err(AppError::InputNotFound(path));
    }
    if kind == JobKind::Trim && trim.is_none() && !settings.mute_audio {
        return Err(AppError::InvalidTrimRange);
    }
    Ok(manager
        .enqueue(
            path,
            output_mode(replace),
            trim,
            kind,
            clean_output_name(output_name),
            CompressionSettings::from_input(&settings),
            true,
        )
        .await)
}

#[tauri::command]
async fn update_queued_job(
    job_id: String,
    replace: bool,
    trim: Option<TrimRange>,
    kind: JobKind,
    output_name: Option<String>,
    settings: JobSettingsInput,
    manager: State<'_, Arc<JobManager>>,
) -> Result<CompressionJob, AppError> {
    if kind == JobKind::Trim && trim.is_none() && !settings.mute_audio {
        return Err(AppError::InvalidTrimRange);
    }
    manager
        .update_queued(
            &job_id,
            trim,
            kind,
            clean_output_name(output_name),
            CompressionSettings::from_input(&settings),
            output_mode(replace),
        )
        .await
        .ok_or_else(|| AppError::Io("that job isnt waiting anymore".to_string()))
}

#[tauri::command]
async fn start_draft(
    job_id: String,
    manager: State<'_, Arc<JobManager>>,
) -> Result<bool, AppError> {
    Ok(manager.start_draft(&job_id).await)
}

#[tauri::command]
async fn start_all_drafts(
    manager: State<'_, Arc<JobManager>>,
) -> Result<usize, AppError> {
    Ok(manager.start_all_drafts().await)
}

#[tauri::command]
async fn ingest_paths(
    paths: Vec<String>,
    replace: bool,
    settings: JobSettingsInput,
    manager: State<'_, Arc<JobManager>>,
) -> Result<DropIngestResult, AppError> {
    media::binaries::ensure()?;
    if paths.is_empty() {
        return Err(AppError::InvalidVideo("nothing was dropped".to_string()));
    }

    let mode = output_mode(replace);
    let resolved = CompressionSettings::from_input(&settings);

    if paths.len() == 1 {
        let only = Path::new(&paths[0]);
        if only.is_dir() {
            let videos = discovery::discover_videos(only)?;
            if videos.is_empty() {
                return Err(AppError::InvalidVideo(
                    "no supported videos in that folder".to_string(),
                ));
            }
            let (added, first) =
                stage_videos(&manager, &videos, mode, &resolved).await;
            if added == 0 {
                return Err(AppError::Io(
                    "those videos are already in the queue".to_string(),
                ));
            }
            return Ok(DropIngestResult {
                jobs_added: added,
                preview_path: first,
            });
        }

        if discovery::has_video_extension(only) {
            // Always stage a draft so single picks stay in the queue like multi-select.
            // Explicit picks use extension-only so prior outputs aren't silently dropped.
            let (added, first) =
                stage_videos(&manager, &[only.to_path_buf()], mode, &resolved).await;
            return Ok(DropIngestResult {
                jobs_added: added,
                preview_path: first.or_else(|| Some(only.display().to_string())),
            });
        }

        return Err(AppError::InvalidVideo(
            "that file isnt a supported video".to_string(),
        ));
    }

    let mut added = 0;
    let mut first_preview: Option<String> = None;
    let mut saw_video = false;
    let mut loose_videos: Vec<String> = Vec::new();

    for raw in paths {
        let path = Path::new(&raw);
        if path.is_dir() {
            let videos = discovery::discover_videos(path)?;
            if !videos.is_empty() {
                saw_video = true;
            }
            let (n, first) = stage_videos(&manager, &videos, mode, &resolved).await;
            added += n;
            if first_preview.is_none() {
                first_preview = first;
            }
        } else if discovery::has_video_extension(path) {
            // Explicit multi-select: keep every picked video file, including
            // names that folder-scan would treat as Squeeze outputs.
            saw_video = true;
            loose_videos.push(raw);
        }
    }

    if !loose_videos.is_empty() {
        let (n, first) =
            stage_video_paths(&manager, &loose_videos, mode, &resolved).await;
        added += n;
        if first_preview.is_none() {
            first_preview = first;
        }
    }

    if !saw_video {
        return Err(AppError::InvalidVideo(
            "no supported videos in that drop".to_string(),
        ));
    }

    if added == 0 && first_preview.is_none() {
        return Err(AppError::Io(
            "those videos are already in the queue".to_string(),
        ));
    }

    Ok(DropIngestResult {
        jobs_added: added,
        preview_path: first_preview,
    })
}

async fn stage_videos(
    manager: &Arc<JobManager>,
    videos: &[std::path::PathBuf],
    mode: OutputMode,
    settings: &CompressionSettings,
) -> (usize, Option<String>) {
    let paths: Vec<String> = videos
        .iter()
        .map(|video| video.to_string_lossy().into_owned())
        .collect();
    stage_video_paths(manager, &paths, mode, settings).await
}

async fn stage_video_paths(
    manager: &Arc<JobManager>,
    videos: &[String],
    mode: OutputMode,
    settings: &CompressionSettings,
) -> (usize, Option<String>) {
    let mut added = 0;
    let mut first: Option<String> = None;
    for path in videos {
        if manager
            .enqueue_new(
                path.clone(),
                mode,
                None,
                JobKind::Squeeze,
                None,
                settings.clone(),
                false,
            )
            .await
            .is_some()
        {
            added += 1;
            if first.is_none() {
                first = Some(path.clone());
            }
        } else if first.is_none() {
            first = Some(path.clone());
        }
    }
    (added, first)
}

#[tauri::command]
async fn list_jobs(manager: State<'_, Arc<JobManager>>) -> Result<Vec<CompressionJob>, AppError> {
    Ok(manager.list().await)
}

#[tauri::command]
async fn cancel_job(
    job_id: String,
    manager: State<'_, Arc<JobManager>>,
) -> Result<bool, AppError> {
    Ok(manager.cancel(&job_id).await)
}

#[tauri::command]
async fn retry_job(
    job_id: String,
    manager: State<'_, Arc<JobManager>>,
) -> Result<CompressionJob, AppError> {
    manager
        .retry(&job_id)
        .await
        .ok_or_else(|| AppError::Io("cant retry that job".to_string()))
}

#[tauri::command]
async fn clear_finished_jobs(manager: State<'_, Arc<JobManager>>) -> Result<usize, AppError> {
    Ok(manager.clear_finished().await)
}

#[tauri::command]
async fn cancel_all_jobs(manager: State<'_, Arc<JobManager>>) -> Result<usize, AppError> {
    Ok(manager.cancel_all_pending().await)
}

const VIDEO_EXTENSIONS: &[&str] = discovery::VIDEO_EXTENSIONS;

#[tauri::command]
fn take_pending_open_paths(state: State<'_, PendingOpens>) -> Vec<String> {
    match state.0.lock() {
        Ok(mut queued) => std::mem::take(&mut *queued),
        Err(poisoned) => std::mem::take(&mut *poisoned.into_inner()),
    }
}

#[tauri::command]
async fn pick_videos() -> Result<Option<Vec<String>>, AppError> {
    let picked = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Pick videos")
            .add_filter("Video", VIDEO_EXTENSIONS)
            .pick_files()
            .map(|paths| {
                paths
                    .into_iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
            })
    })
    .await
    .map_err(|err| AppError::PickerFailed(err.to_string()))?;

    Ok(picked)
}

#[tauri::command]
async fn pick_folder() -> Result<Option<String>, AppError> {
    let picked = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .set_title("Pick a folder of videos")
            .pick_folder()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|err| AppError::PickerFailed(err.to_string()))?;

    Ok(picked)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let manager = Arc::new(JobManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            focus_main_window(app);
            let paths = collect_video_args(argv.into_iter().skip(1));
            enqueue_open_paths(app, paths);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(PendingOpens::default())
        .manage(manager.clone())
        .setup(move |app| {
            worker::spawn_worker(app.handle().clone(), manager);

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.center();
                let icon = tauri::include_image!("icons/icon.png");
                let _ = window.set_icon(icon);
            }

            let launch_paths = collect_video_args(std::env::args().skip(1));
            enqueue_open_paths(app.handle(), launch_paths);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_media,
            preview_plan,
            extract_filmstrip,
            enqueue_job,
            update_queued_job,
            start_draft,
            start_all_drafts,
            ingest_paths,
            list_jobs,
            cancel_job,
            retry_job,
            clear_finished_jobs,
            cancel_all_jobs,
            take_pending_open_paths,
            pick_videos,
            pick_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod launch_arg_tests {
    use super::collect_video_args;

    fn scratch_video(name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "squeeze-open-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(name);
        std::fs::write(&file, b"not a real video").unwrap();
        (dir, file)
    }

    #[test]
    fn keeps_quoted_paths_with_spaces() {
        let (dir, file) = scratch_video("my clip.mp4");
        let quoted = format!("\"{}\"", file.display());
        let parsed = collect_video_args([quoted]);
        assert_eq!(parsed, vec![file.display().to_string()]);
        let plain = collect_video_args([file.display().to_string()]);
        assert_eq!(plain, vec![file.display().to_string()]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_a_quoted_path_inside_a_larger_argument() {
        let (dir, file) = scratch_video("holiday film.mkv");
        let blob = format!(
            "C:\\Program Files\\Squeeze\\squeeze.exe \"{}\"",
            file.display()
        );
        let parsed = collect_video_args([blob, "--flag".to_string()]);
        assert_eq!(parsed, vec![file.display().to_string()]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn opens_explicit_squeeze_outputs_and_skips_missing_files() {
        let (dir, file) = scratch_video("clip-squeezed.mp4");
        let missing = dir.join("gone.mov");
        let parsed = collect_video_args([
            file.display().to_string(),
            missing.display().to_string(),
            "notes.txt".to_string(),
        ]);
        assert_eq!(parsed, vec![file.display().to_string()]);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
