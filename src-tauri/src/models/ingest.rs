use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DropIngestResult {
    pub jobs_added: usize,
    /// if they dropped one lone video, ui can open the trim preview
    pub preview_path: Option<String>,
    /// folder roots that were ingested (so ui can expand subfolders later)
    pub folder_roots: Vec<String>,
}
