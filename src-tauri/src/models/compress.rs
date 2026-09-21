use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressResult {
    pub output_path: String,
    pub output_size_bytes: u64,
    pub skipped: bool,
}
