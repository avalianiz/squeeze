use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};
use tauri::window::{ProgressBarState, ProgressBarStatus};

use crate::error::AppError;
use crate::jobs::state::JobManager;
use crate::media::ffmpeg;
use crate::models::{JobProgress, JobStatus};

pub fn spawn_worker(app: AppHandle, manager: Arc<JobManager>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let job = manager.wait_next_queued().await;
            run_one(&app, manager.clone(), job.id.clone()).await;
        }
    });
}

fn set_taskbar_progress(app: &AppHandle, percent: Option<u64>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let state = match percent {
        Some(p) => ProgressBarState {
            status: Some(ProgressBarStatus::Normal),
            progress: Some(p.min(100)),
        },
        None => ProgressBarState {
            status: Some(ProgressBarStatus::None),
            progress: None,
        },
    };
    let _ = window.set_progress_bar(state);
}

fn notify_queue_idle(app: &AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("Squeeze")
        .body("Queue finished")
        .show();
}

async fn run_one(app: &AppHandle, manager: Arc<JobManager>, job_id: String) {
    let Some(job) = manager
        .list()
        .await
        .into_iter()
        .find(|j| j.id == job_id)
    else {
        return;
    };

    if job.status == JobStatus::Cancelled {
        return;
    }

    let Some(cancel) = manager.cancel_flag(&job_id).await else {
        return;
    };

    if cancel.load(Ordering::SeqCst) {
        manager.set_cancelled(&job_id).await;
        let _ = app.emit("job-updated", manager.list().await);
        return;
    }

    manager.set_running(&job_id).await;
    set_taskbar_progress(app, Some(0));
    let _ = app.emit("job-updated", manager.list().await);

    if let Err(err) = crate::media::binaries::ensure() {
        manager.set_failed(&job_id, err.to_string()).await;
        set_taskbar_progress(app, None);
        let _ = app.emit("job-updated", manager.list().await);
        return;
    }

    let app_progress = app.clone();
    let manager_progress = manager.clone();
    let progress_id = job_id.clone();

    let result = ffmpeg::run_job(
        std::path::Path::new(&job.input_path),
        &job.settings,
        job.output_mode,
        job.trim.clone(),
        job.output_name.clone(),
        job.kind,
        cancel,
        move |elapsed, duration, percentage| {
            let manager = manager_progress.clone();
            let app = app_progress.clone();
            let job_id = progress_id.clone();
            tauri::async_runtime::spawn(async move {
                manager.set_progress(&job_id, percentage).await;
                set_taskbar_progress(&app, Some(percentage.round() as u64));
                let _ = app.emit(
                    "job-progress",
                    JobProgress {
                        job_id,
                        elapsed_seconds: elapsed,
                        duration_seconds: duration,
                        percentage,
                        output_size_bytes: None,
                    },
                );
            });
        },
    )
    .await;

    match result {
        Ok(done) => {
            manager
                .set_succeeded(
                    &job_id,
                    done.output_path,
                    done.output_size_bytes,
                    done.skipped,
                    done.note,
                    done.retried,
                )
                .await;
        }
        Err(AppError::Cancelled) => {
            manager.set_cancelled(&job_id).await;
        }
        Err(err) => {
            manager.set_failed(&job_id, err.to_string()).await;
        }
    }

    let still_active = manager.has_active().await;
    if still_active {
        set_taskbar_progress(app, Some(0));
    } else {
        set_taskbar_progress(app, None);
        notify_queue_idle(app);
    }

    let _ = app.emit("job-updated", manager.list().await);
}
