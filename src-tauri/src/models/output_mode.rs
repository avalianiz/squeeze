use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutputMode {
    // write beside the source (foo-squeezed.mp4, or exact custom name)
    CopyBeside,
    // swap the original after a successful encode
    Replace,
}
