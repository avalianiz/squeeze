use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    /// Compress toward the Discord size target (optional trim).
    Squeeze,
    /// Cut the selected range without size-targeting.
    Trim,
}
