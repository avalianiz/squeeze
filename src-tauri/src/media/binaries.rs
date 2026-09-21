use crate::error::AppError;

// grab ffmpeg/ffprobe from our binaries folder, otherwise hope its on PATH
pub fn resolve(tool: &str) -> Result<std::path::PathBuf, AppError> {
    #[cfg(windows)]
    let file_name = format!("{tool}.exe");
    #[cfg(not(windows))]
    let file_name = tool.to_string();

    let bundled = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(&file_name);

    if bundled.exists() {
        return Ok(bundled);
    }

    Ok(std::path::PathBuf::from(file_name))
}

pub fn hide_console(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}
