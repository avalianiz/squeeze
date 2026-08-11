use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
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
    #[serde(default)]
    pub mute_audio: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSettingsInput {
    pub target_size_bytes: Option<u64>,
    #[serde(default)]
    pub mute_audio: bool,
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
            mute_audio: false,
        }
    }

    pub fn from_input(input: &JobSettingsInput) -> Self {
        let mut settings = match input.target_size_bytes {
            Some(bytes) => Self::with_target_bytes(bytes),
            None => Self::default_target(),
        };
        settings.mute_audio = input.mute_audio;
        settings.max_width = input.max_width;
        settings.max_height = input.max_height;
        settings.max_fps = input.max_fps;
        if settings.mute_audio {
            settings.audio_bitrate_kbps = 0;
        }
        settings
    }

    pub fn effective_audio_bitrate_kbps(&self) -> u32 {
        if self.mute_audio {
            0
        } else {
            self.audio_bitrate_kbps
        }
    }
}
