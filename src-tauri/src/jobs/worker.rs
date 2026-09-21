use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use crate::jobs::state::JobManager;
use crate::media::ffmpeg;
use crate::models::{JobProgress, JobStatus};

// one encode at a time. more than that melts most laptops.
pub fn spawn_worker(app: AppHandle, manager: Arc<JobManager>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let job = manager.wait_next_queued().await;
            run_one(&app, manager.clone(), job.id.clone()).await;
        }
    });
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
    let _ = app.emit("job-updated", manager.list().await);

    if let Err(err) = crate::media::binaries::ensure(app).await {
        manager
            .set_failed(&job_id, err.to_string())
            .await;
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
                let _ = app.emit(
                    "job-progress",
                    JobProgress {
                        job_id: job_id.clone(),
                        elapsed_seconds: elapsed,
                        duration_seconds: duration,
                        percentage,
                        output_size_bytes: None,
                    },
                );
                let _ = app.emit("job-updated", manager.list().await);
            });
        },
    )
    .await;

    match result {
        Ok(done) => {
            manager
                .set_succeeded(&job_id, done.output_path, done.output_size_bytes)
                .await;
        }
        Err(AppError::Cancelled) => {
            manager.set_cancelled(&job_id).await;
        }
        Err(err) => {
            manager.set_failed(&job_id, err.to_string()).await;
        }
    }

    let _ = app.emit("job-updated", manager.list().await);
}
