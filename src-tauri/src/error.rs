use serde::Serialize;

#[derive(Debug)]
pub enum AppError {
    FfprobeNotFound,
    FfmpegNotFound,
    /// Returned when the host OS/arch has no bundled sidecar target.
    #[allow(dead_code)]
    UnsupportedPlatform,
    FfprobeFailed(String),
    EncodingFailed(String),
    Io(String),
    PickerFailed(String),
    InputNotFound(String),
    OutputAlreadyExists(String),
    InvalidVideo(String),
    TargetBitrateTooLow,
    Cancelled,
    InvalidTrimRange,
}

fn missing_engine_message() -> &'static str {
    // Users never run npm — shipped builds should always include sidecars.
    // Dev builds get the setup hint when someone forgot `npm run setup:ffmpeg`.
    if cfg!(debug_assertions) {
        "Squeeze's video engine is missing. For local builds, run: npm run setup:ffmpeg"
    } else {
        "Squeeze's video engine is missing. Please reinstall Squeeze."
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::FfprobeNotFound | AppError::FfmpegNotFound => {
                write!(f, "{}", missing_engine_message())
            }
            AppError::UnsupportedPlatform => {
                write!(
                    f,
                    "Squeeze isn't available on this system yet (need Windows x64, Linux x64, or macOS Intel/Apple Silicon)."
                )
            }
            AppError::FfprobeFailed(message) => write!(f, "ffprobe failed: {message}"),
            AppError::EncodingFailed(message) => write!(f, "encode failed: {message}"),
            AppError::Io(message) => write!(f, "{message}"),
            AppError::PickerFailed(message) => write!(f, "file picker failed: {message}"),
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
            AppError::Cancelled => write!(f, "cancelled"),
            AppError::InvalidTrimRange => write!(f, "trim range doesnt make sense"),
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
