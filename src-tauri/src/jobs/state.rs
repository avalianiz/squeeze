use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::{Mutex, Notify};

use crate::models::{CompressionJob, CompressionSettings, JobKind, JobStatus, OutputMode, TrimRange};

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

    pub async fn enqueue(
        &self,
        input_path: String,
        output_mode: OutputMode,
        trim: Option<TrimRange>,
        kind: JobKind,
        output_name: Option<String>,
    ) -> CompressionJob {
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
            output_mode,
            trim,
            kind,
            output_name,
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

    /// queue only if this input isnt already in the list (any status).
    /// failed/cancelled use retry — dont invent duplicates from folder re-scan.
    pub async fn enqueue_new(
        &self,
        input_path: String,
        output_mode: OutputMode,
        trim: Option<TrimRange>,
        kind: JobKind,
        output_name: Option<String>,
    ) -> Option<CompressionJob> {
        {
            let inner = self.inner.lock().await;
            let already = inner
                .jobs
                .iter()
                .any(|j| crate::filesystem::discovery::same_path(&j.input_path, &input_path));
            if already {
                return None;
            }
        }
        Some(
            self.enqueue(input_path, output_mode, trim, kind, output_name)
                .await,
        )
    }

    /// stamp the same trim/kind onto every still-waiting job (optionally under folder roots).
    pub async fn apply_to_queued(
        &self,
        trim: Option<TrimRange>,
        kind: JobKind,
        folder_roots: Option<Vec<String>>,
    ) -> usize {
        let mut inner = self.inner.lock().await;
        let mut changed = 0;
        for job in inner.jobs.iter_mut() {
            if job.status != JobStatus::Queued {
                continue;
            }
            if let Some(roots) = &folder_roots {
                let under = roots
                    .iter()
                    .any(|root| crate::filesystem::discovery::path_under_root(&job.input_path, root));
                if !under {
                    continue;
                }
            }
            job.trim = trim.clone();
            job.kind = kind;
            changed += 1;
        }
        changed
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
        let (input, mode, trim, kind, output_name) = {
            let job = inner.jobs.iter().find(|j| j.id == job_id)?;
            if !matches!(job.status, JobStatus::Failed | JobStatus::Cancelled) {
                return None;
            }
            (
                job.input_path.clone(),
                job.output_mode,
                job.trim.clone(),
                job.kind,
                job.output_name.clone(),
            )
        };
        drop(inner);
        Some(self.enqueue(input, mode, trim, kind, output_name).await)
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

    pub async fn clear_finished(&self) -> usize {
        let mut inner = self.inner.lock().await;
        let before = inner.jobs.len();
        inner.jobs.retain(|job| {
            matches!(job.status, JobStatus::Queued | JobStatus::Running)
        });
        // drop cancel flags for removed jobs
        let keep: std::collections::HashSet<_> =
            inner.jobs.iter().map(|j| j.id.clone()).collect();
        inner.cancels.retain(|id, _| keep.contains(id));
        before - inner.jobs.len()
    }

    pub async fn cancel_all_pending(&self) -> usize {
        let mut inner = self.inner.lock().await;
        let mut count = 0;
        let mut running_ids = Vec::new();

        for job in inner.jobs.iter_mut() {
            match job.status {
                JobStatus::Queued => {
                    job.status = JobStatus::Cancelled;
                    job.error = Some("cancelled".to_string());
                    count += 1;
                }
                JobStatus::Running => {
                    running_ids.push(job.id.clone());
                    count += 1;
                }
                _ => {}
            }
        }

        for id in running_ids {
            if let Some(flag) = inner.cancels.get(&id) {
                flag.store(true, Ordering::SeqCst);
            }
        }

        count
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
