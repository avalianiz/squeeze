use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DropIngestResult {
    pub jobs_added: usize,
    /// if they dropped one lone video, ui can open the trim preview
    pub preview_path: Option<String>,
}
