mod error;
mod filesystem;
mod jobs;
mod media;
mod models;

use std::path::Path;
use std::sync::Arc;

use error::AppError;
use filesystem::discovery;
use filesystem::output::sanitize_stem;
use jobs::state::JobManager;
use jobs::worker;
use models::{
    CompressionJob, CompressionSettings, DropIngestResult, JobKind, Media, OutputMode, TrimRange,
};
use tauri::{Manager, State};

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

fn resolve_settings(target_size_bytes: Option<u64>) -> CompressionSettings {
    match target_size_bytes {
        Some(bytes) => CompressionSettings::with_target_bytes(bytes),
        None => CompressionSettings::default_target(),
    }
}

#[tauri::command]
async fn probe_media(path: String) -> Result<Media, AppError> {
    media::binaries::ensure()?;
    media::ffprobe::probe(Path::new(&path)).await
}

#[tauri::command]
async fn enqueue_job(
    path: String,
    replace: bool,
    trim: Option<TrimRange>,
    kind: JobKind,
    output_name: Option<String>,
    target_size_bytes: Option<u64>,
    manager: State<'_, Arc<JobManager>>,
) -> Result<CompressionJob, AppError> {
    if !Path::new(&path).exists() {
        return Err(AppError::InputNotFound(path));
    }
    if kind == JobKind::Trim && trim.is_none() {
        return Err(AppError::InvalidTrimRange);
    }
    Ok(manager
        .enqueue(
            path,
            output_mode(replace),
            trim,
            kind,
            clean_output_name(output_name),
            resolve_settings(target_size_bytes),
        )
        .await)
}

#[tauri::command]
async fn ingest_paths(
    paths: Vec<String>,
    replace: bool,
    target_size_bytes: Option<u64>,
    manager: State<'_, Arc<JobManager>>,
) -> Result<DropIngestResult, AppError> {
    media::binaries::ensure()?;
    if paths.is_empty() {
        return Err(AppError::InvalidVideo("nothing was dropped".to_string()));
    }

    let mode = output_mode(replace);
    let settings = resolve_settings(target_size_bytes);

    if paths.len() == 1 {
        let only = Path::new(&paths[0]);
        if only.is_dir() {
            let videos = discovery::discover_videos(only)?;
            if videos.is_empty() {
                return Err(AppError::InvalidVideo(
                    "no supported videos in that folder".to_string(),
                ));
            }
            let added = enqueue_videos(&manager, &videos, mode, &settings).await;
            if added == 0 {
                return Err(AppError::Io(
                    "those videos are already in the queue".to_string(),
                ));
            }
            return Ok(DropIngestResult {
                jobs_added: added,
                preview_path: None,
            });
        }

        if discovery::is_supported_video(only) {
            return Ok(DropIngestResult {
                jobs_added: 0,
                preview_path: Some(only.display().to_string()),
            });
        }

        return Err(AppError::InvalidVideo(
            "that file isnt a supported video".to_string(),
        ));
    }

    let mut added = 0;
    let mut last_video: Option<String> = None;
    let mut saw_folder = false;
    let mut saw_video = false;

    for raw in paths {
        let path = Path::new(&raw);
        if path.is_dir() {
            saw_folder = true;
            let videos = discovery::discover_videos(path)?;
            if !videos.is_empty() {
                saw_video = true;
            }
            added += enqueue_videos(&manager, &videos, mode, &settings).await;
        } else if discovery::is_supported_video(path) {
            saw_video = true;
            last_video = Some(path.display().to_string());
            if manager
                .enqueue_new(
                    path.display().to_string(),
                    mode,
                    None,
                    JobKind::Squeeze,
                    None,
                    settings.clone(),
                )
                .await
                .is_some()
            {
                added += 1;
            }
        }
    }

    if !saw_video {
        return Err(AppError::InvalidVideo(
            "no supported videos in that drop".to_string(),
        ));
    }

    if added == 0 {
        return Err(AppError::Io(
            "those videos are already in the queue".to_string(),
        ));
    }

    Ok(DropIngestResult {
        jobs_added: added,
        preview_path: if saw_folder { None } else { last_video },
    })
}

async fn enqueue_videos(
    manager: &Arc<JobManager>,
    videos: &[std::path::PathBuf],
    mode: OutputMode,
    settings: &CompressionSettings,
) -> usize {
    let mut added = 0;
    for video in videos {
        if manager
            .enqueue_new(
                video.display().to_string(),
                mode,
                None,
                JobKind::Squeeze,
                None,
                settings.clone(),
            )
            .await
            .is_some()
        {
            added += 1;
        }
    }
    added
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
        .plugin(tauri_plugin_opener::init())
        .manage(manager.clone())
        .setup(move |app| {
            worker::spawn_worker(app.handle().clone(), manager);

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.center();
                let icon = tauri::include_image!("icons/icon.png");
                let _ = window.set_icon(icon);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_media,
            enqueue_job,
            ingest_paths,
            list_jobs,
            cancel_job,
            retry_job,
            clear_finished_jobs,
            cancel_all_jobs,
            pick_videos,
            pick_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
