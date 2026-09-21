use serde::Serialize;

/// Errors we can actually explain to the user.
/// Keep variants specific so later phases (ffmpeg, trim, jobs) can reuse this.
#[derive(Debug)]
pub enum AppError {
    FfprobeNotFound,
    FfprobeFailed(String),
    InputNotFound(String),
    InvalidVideo(String),
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::FfprobeNotFound => write!(
                f,
                "ffprobe isn't installed. drop ffprobe.exe in src-tauri/binaries or put ffmpeg on PATH"
            ),
            AppError::FfprobeFailed(message) => write!(f, "ffprobe failed: {message}"),
            AppError::InputNotFound(path) => write!(f, "couldn't find that file: {path}"),
            AppError::InvalidVideo(message) => write!(f, "that doesn't look like a video: {message}"),
        }
    }
}

impl std::error::Error for AppError {}

// Tauri turns command errors into a string the frontend can show.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
