use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanPreview {
    pub ok: bool,
    pub duration_seconds: f64,
    pub target_size_bytes: u64,
    pub video_bitrate_bps: Option<u32>,
    pub audio_bitrate_bps: u32,
    pub message: String,
    pub squeeze_blocked: bool,
    pub suggested_fit_label: Option<String>,
    pub suggested_max_width: Option<u32>,
    pub suggested_max_height: Option<u32>,
    pub suggested_max_fps: Option<u32>,
    pub suggested_mute: bool,
    pub suggested_target_mb: Option<u32>,
}
