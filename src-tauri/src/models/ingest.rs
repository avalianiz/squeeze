use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DropIngestResult {
    pub jobs_added: usize,
    pub preview_path: Option<String>,
}
