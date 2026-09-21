use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OutputMode {
    // write foo-squeezed.mp4 next to the source
    CopyBeside,
    // swap the original after a successful encode
    Replace,
}
