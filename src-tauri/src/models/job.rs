use serde::{Deserialize, Serialize};

use crate::models::{CompressionSettings, OutputMode};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressionJob {
    pub id: String,
    pub input_path: String,
    pub output_path: Option<String>,
    pub status: JobStatus,
    pub error: Option<String>,
    pub progress_percent: f64,
    pub output_size_bytes: Option<u64>,
    pub settings: CompressionSettings,
    pub output_mode: OutputMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobProgress {
    pub job_id: String,
    pub elapsed_seconds: f64,
    pub duration_seconds: f64,
    pub percentage: f64,
    pub output_size_bytes: Option<u64>,
}
