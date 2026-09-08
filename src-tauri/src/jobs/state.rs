use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::{Mutex, Notify};

use crate::models::{CompressionJob, CompressionSettings, JobKind, JobStatus, OutputMode, TrimRange};

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
        settings: CompressionSettings,
        start: bool,
    ) -> CompressionJob {
        let id = uuid::Uuid::new_v4().to_string();
        let job = CompressionJob {
            id: id.clone(),
            input_path,
            output_path: None,
            status: if start {
                JobStatus::Queued
            } else {
                JobStatus::Draft
            },
            error: None,
            progress_percent: 0.0,
            output_size_bytes: None,
            settings,
            output_mode,
            trim,
            kind,
            output_name,
            skipped: false,
            note: None,
            retried: false,
        };

        let mut inner = self.inner.lock().await;
        inner
            .cancels
            .insert(id.clone(), Arc::new(AtomicBool::new(false)));
        inner.jobs.push(job.clone());
        drop(inner);

        if start {
            self.wake.notify_one();
        }
        job
    }

    pub async fn enqueue_new(
        &self,
        input_path: String,
        output_mode: OutputMode,
        trim: Option<TrimRange>,
        kind: JobKind,
        output_name: Option<String>,
        settings: CompressionSettings,
        start: bool,
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
            self.enqueue(
                input_path,
                output_mode,
                trim,
                kind,
                output_name,
                settings,
                start,
            )
            .await,
        )
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
                JobStatus::Draft | JobStatus::Queued => {
                    job.status = JobStatus::Cancelled;
                    job.error = Some("cancelled".to_string());
                    return true;
                }
                JobStatus::Running => {
                    return true;
                }
                _ => return false,
            }
        }
        false
    }

    pub async fn retry(&self, job_id: &str) -> Option<CompressionJob> {
        let mut inner = self.inner.lock().await;
        let cloned = {
            let job = inner.jobs.iter_mut().find(|j| j.id == job_id)?;
            if !matches!(job.status, JobStatus::Failed | JobStatus::Cancelled) {
                return None;
            }

            job.status = JobStatus::Queued;
            job.error = None;
            job.progress_percent = 0.0;
            job.output_path = None;
            job.output_size_bytes = None;
            job.skipped = false;
            job.note = None;
            job.retried = false;
            job.clone()
        };

        if let Some(flag) = inner.cancels.get(job_id) {
            flag.store(false, Ordering::SeqCst);
        } else {
            inner
                .cancels
                .insert(job_id.to_string(), Arc::new(AtomicBool::new(false)));
        }

        drop(inner);
        self.wake.notify_one();
        Some(cloned)
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
        skipped: bool,
        note: Option<String>,
        retried: bool,
    ) {
        let mut inner = self.inner.lock().await;
        if let Some(job) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
            job.status = JobStatus::Succeeded;
            job.progress_percent = 100.0;
            job.output_path = Some(output_path);
            job.output_size_bytes = Some(output_size_bytes);
            job.skipped = skipped;
            job.note = note;
            job.retried = retried;
            job.error = None;
        }
    }

    pub async fn update_queued(
        &self,
        job_id: &str,
        trim: Option<TrimRange>,
        kind: JobKind,
        output_name: Option<String>,
        settings: CompressionSettings,
        output_mode: OutputMode,
    ) -> Option<CompressionJob> {
        let mut inner = self.inner.lock().await;
        let job = inner.jobs.iter_mut().find(|j| j.id == job_id)?;
        if !matches!(job.status, JobStatus::Draft | JobStatus::Queued) {
            return None;
        }
        job.trim = trim;
        job.kind = kind;
        job.output_name = output_name;
        job.settings = settings;
        job.output_mode = output_mode;
        Some(job.clone())
    }

    /// Promote a single draft job to queued and wake the worker.
    pub async fn start_draft(&self, job_id: &str) -> bool {
        let started = {
            let mut inner = self.inner.lock().await;
            let Some(job) = inner.jobs.iter_mut().find(|j| j.id == job_id) else {
                return false;
            };
            if job.status != JobStatus::Draft {
                return false;
            }
            job.status = JobStatus::Queued;
            true
        };
        if started {
            self.wake.notify_one();
        }
        started
    }

    /// Promote every draft job to queued and wake the worker.
    pub async fn start_all_drafts(&self) -> usize {
        let mut started = 0;
        {
            let mut inner = self.inner.lock().await;
            for job in inner.jobs.iter_mut() {
                if job.status == JobStatus::Draft {
                    job.status = JobStatus::Queued;
                    started += 1;
                }
            }
        }
        if started > 0 {
            self.wake.notify_one();
        }
        started
    }

    pub async fn has_active(&self) -> bool {
        self.inner.lock().await.jobs.iter().any(|j| {
            matches!(j.status, JobStatus::Queued | JobStatus::Running)
        })
    }

    pub async fn set_failed(&self, job_id: &str, error: String) {
        let mut inner = self.inner.lock().await;
        if let Some(job) = inner.jobs.iter_mut().find(|j| j.id == job_id) {
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
            matches!(
                job.status,
                JobStatus::Draft | JobStatus::Queued | JobStatus::Running
            )
        });
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
                JobStatus::Draft | JobStatus::Queued => {
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
