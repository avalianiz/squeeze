use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::{Mutex, Notify};

use crate::models::{CompressionJob, CompressionSettings, JobStatus};

// all the job list + cancel flags live here. worker peeks at this.
pub struct JobManager {
    inner: Mutex<Inner>,
    wake: Notify,
}

struct Inner {
    jobs: Vec<CompressionJob>,
    cancels: HashMap<String, Arc<AtomicBool>>,
}

impl JobManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                jobs: Vec::new(),
                cancels: HashMap::new(),
            }),
            wake: Notify::new(),
        }
    }

    pub async fn enqueue(&self, input_path: String) -> CompressionJob {
        let id = uuid::Uuid::new_v4().to_string();
        let job = CompressionJob {
            id: id.clone(),
            input_path,
            output_path: None,
            status: JobStatus::Queued,
            error: None,
            progress_percent: 0.0,
            output_size_bytes: None,
            settings: CompressionSettings::discord(),
        };

        let mut inner = self.inner.lock().await;
        inner
            .cancels
            .insert(id.clone(), Arc::new(AtomicBool::new(false)));
        inner.jobs.push(job.clone());
        drop(inner);

        self.wake.notify_one();
        job
    }

    pub async fn list(&self) -> Vec<CompressionJob> {
        self.inner.lock().await.jobs.clone()
    }

    pub async fn cancel(&self, job_id: &str) -> bool {
        let mut inner = self.inner.lock().await;

        if let Some(flag) = inner.cancels.get(job_id) {
            flag.store(true, Ordering::SeqCst);
        }

        if let Some(job) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
            match job.status {
                JobStatus::Queued => {
                    job.status = JobStatus::Cancelled;
                    job.error = Some("cancelled".to_string());
                    return true;
                }
                JobStatus::Running => {
                    // worker will notice the flag and kill ffmpeg
                    return true;
                }
                _ => return false,
            }
        }
        false
    }

    pub async fn retry(&self, job_id: &str) -> Option<CompressionJob> {
        let inner = self.inner.lock().await;
        let input = {
            let job = inner.jobs.iter().find(|j| j.id == job_id)?;
            if !matches!(job.status, JobStatus::Failed | JobStatus::Cancelled) {
                return None;
            }
            job.input_path.clone()
        };
        drop(inner);
        Some(self.enqueue(input).await)
    }

    pub async fn cancel_flag(&self, job_id: &str) -> Option<Arc<AtomicBool>> {
        self.inner.lock().await.cancels.get(job_id).cloned()
    }

    pub async fn set_running(&self, job_id: &str) {
        let mut inner = self.inner.lock().await;
        if let Some(job) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
            job.status = JobStatus::Running;
            job.progress_percent = 0.0;
            job.error = None;
        }
    }

    pub async fn set_progress(&self, job_id: &str, percent: f64) {
        let mut inner = self.inner.lock().await;
        if let Some(job) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
            job.progress_percent = percent.clamp(0.0, 100.0);
        }
    }

    pub async fn set_succeeded(
        &self,
        job_id: &str,
        output_path: String,
        output_size_bytes: u64,
    ) {
        let mut inner = self.inner.lock().await;
        if let Some(job) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
            job.status = JobStatus::Succeeded;
            job.progress_percent = 100.0;
            job.output_path = Some(output_path);
            job.output_size_bytes = Some(output_size_bytes);
            job.error = None;
        }
    }

    pub async fn set_failed(&self, job_id: &str, error: String) {
        let mut inner = self.inner.lock().await;
        if let Some(job) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
            // dont overwrite a cancel we already marked
            if job.status == JobStatus::Cancelled {
                return;
            }
            job.status = JobStatus::Failed;
            job.error = Some(error);
        }
    }

    pub async fn set_cancelled(&self, job_id: &str) {
        let mut inner = self.inner.lock().await;
        if let Some(job) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
            job.status = JobStatus::Cancelled;
            job.error = Some("cancelled".to_string());
        }
    }

    // grabs the next queued job, or waits until something shows up
    pub async fn wait_next_queued(&self) -> CompressionJob {
        loop {
            {
                let inner = self.inner.lock().await;
                if let Some(job) = inner
                    .jobs
                    .iter()
                    .find(|j| j.status == JobStatus::Queued)
                    .cloned()
                {
                    return job;
                }
            }
            self.wake.notified().await;
        }
    }
}
