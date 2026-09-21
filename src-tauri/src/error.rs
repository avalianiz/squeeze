use serde::Serialize;

#[derive(Debug)]
pub enum AppError {
    FfprobeNotFound,
    FfmpegNotFound,
    FfprobeFailed(String),
    EncodingFailed(String),
    InputNotFound(String),
    OutputAlreadyExists(String),
    InvalidVideo(String),
    TargetBitrateTooLow,
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::FfprobeNotFound => write!(f, "couldn't find ffprobe"),
            AppError::FfmpegNotFound => write!(f, "couldn't find ffmpeg"),
            AppError::FfprobeFailed(message) => write!(f, "ffprobe failed: {message}"),
            AppError::EncodingFailed(message) => write!(f, "encode failed: {message}"),
            AppError::InputNotFound(path) => write!(f, "couldn't find that file: {path}"),
            AppError::OutputAlreadyExists(path) => {
                write!(f, "output already exists: {path}")
            }
            AppError::InvalidVideo(message) => {
                write!(f, "that doesn't look like a video: {message}")
            }
            AppError::TargetBitrateTooLow => write!(
                f,
                "video is too long/short to fit the target size with usable quality"
            ),
        }
    }
}

impl std::error::Error for AppError {}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
