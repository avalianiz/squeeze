use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoCodec {
    H264,
}

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
    pub fn default_target() -> Self {
        Self::with_target_bytes(20 * 1024 * 1024)
    }

    pub fn with_target_bytes(target_size_bytes: u64) -> Self {
        Self {
            target_size_bytes: target_size_bytes.max(256 * 1024),
            video_codec: VideoCodec::H264,
            audio_bitrate_kbps: 128,
            max_width: None,
            max_height: None,
            max_fps: None,
        }
    }
}
