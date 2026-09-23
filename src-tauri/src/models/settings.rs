use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoCodec {
    H264,
}

/// Encoder knobs used by the ffmpeg pipeline.
///
/// `max_width` / `max_height` / `max_fps` are applied when set (see `encode_to`).
/// `discord()` leaves them unset until the UI exposes size/quality controls.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressionSettings {
    pub target_size_bytes: u64,
    pub video_codec: VideoCodec,
    pub audio_bitrate_kbps: u32,
    pub max_width: Option<u32>,
    pub max_height: Option<u32>,
    pub max_fps: Option<u32>,
}

impl CompressionSettings {
    // discord free upload is 20mb so we aim a bit under that
    pub fn discord() -> Self {
        Self {
            target_size_bytes: (19.5 * 1024.0 * 1024.0) as u64,
            video_codec: VideoCodec::H264,
            audio_bitrate_kbps: 128,
            max_width: None,
            max_height: None,
            max_fps: None,
        }
    }
}
