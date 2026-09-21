mod error;
mod filesystem;
mod jobs;
mod media;
mod models;

use std::path::Path;
use std::sync::Arc;

use error::AppError;
use filesystem::discovery;
use jobs::state::JobManager;
use jobs::worker;
use models::{
    CompressionJob, CompressResult, CompressionSettings, Media, OutputMode, TrimRange,
};
use tauri::State;

#[tauri::command]
async fn probe_media(path: String) -> Result<Media, AppError> {
    media::ffprobe::probe(Path::new(&path)).await
}

#[tauri::command]
async fn compress_media(path: String) -> Result<CompressResult, AppError> {
    media::ffmpeg::compress(Path::new(&path), &CompressionSettings::discord()).await
}

#[tauri::command]
async fn enqueue_job(
    path: String,
    replace: bool,
    trim: Option<TrimRange>,
    manager: State<'_, Arc<JobManager>>,
) -> Result<CompressionJob, AppError> {
    if !Path::new(&path).exists() {
        return Err(AppError::InputNotFound(path));
    }
    let mode = if replace {
        OutputMode::Replace
    } else {
        OutputMode::CopyBeside
    };
    Ok(manager.enqueue(path, mode, trim).await)
}

#[tauri::command]
async fn enqueue_folder(
    path: String,
    recursive: bool,
    replace: bool,
    manager: State<'_, Arc<JobManager>>,
) -> Result<Vec<CompressionJob>, AppError> {
    let root = Path::new(&path);
    let videos = discovery::discover_videos(root, recursive)?;
    if videos.is_empty() {
        return Err(AppError::InvalidVideo(
            "no supported videos in that folder".to_string(),
        ));
    }

    let mode = if replace {
        OutputMode::Replace
    } else {
        OutputMode::CopyBeside
    };

    let mut jobs = Vec::with_capacity(videos.len());
    for video in videos {
        jobs.push(
            manager
                .enqueue(video.display().to_string(), mode, None)
                .await,
        );
    }
    Ok(jobs)
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
        .ok_or_else(|| AppError::EncodingFailed("cant retry that job".to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let manager = Arc::new(JobManager::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(manager.clone())
        .setup(move |app| {
            worker::spawn_worker(app.handle().clone(), manager);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_media,
            compress_media,
            enqueue_job,
            enqueue_folder,
            list_jobs,
            cancel_job,
            retry_job
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
