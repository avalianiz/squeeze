use std::path::{Path, PathBuf};

use crate::error::AppError;

pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "mov", "webm", "avi", "m4v", "wmv", "flv",
];

/// Compare paths in a Windows-tolerant way (slash + case).
pub fn path_key(path: &str) -> String {
    let normalized = path.replace('/', "\\");
    #[cfg(windows)]
    {
        normalized.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        normalized
    }
}

pub fn same_path(a: &str, b: &str) -> bool {
    path_key(a) == path_key(b)
}

// find videos in a folder. skips our own squeezed/temp/backup junk.
pub fn discover_videos(root: &Path, recursive: bool) -> Result<Vec<PathBuf>, AppError> {
    if !root.is_dir() {
        return Err(AppError::InputNotFound(root.display().to_string()));
    }

    let mut found = Vec::new();
    scan_dir(root, recursive, &mut found)?;
    found.sort();
    Ok(found)
}

fn scan_dir(dir: &Path, recursive: bool, out: &mut Vec<PathBuf>) -> Result<(), AppError> {
    let entries = std::fs::read_dir(dir).map_err(|e| {
        AppError::EncodingFailed(format!("cant read {}: {e}", dir.display()))
    })?;

    for entry in entries {
        let entry = entry.map_err(|e| AppError::EncodingFailed(e.to_string()))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| AppError::EncodingFailed(e.to_string()))?;

        if file_type.is_dir() {
            if recursive {
                scan_dir(&path, true, out)?;
            }
            continue;
        }

        if file_type.is_file() && is_source_video(&path) {
            out.push(path);
        }
    }

    Ok(())
}

pub fn is_supported_video(path: &Path) -> bool {
    is_source_video(path)
}

fn is_source_video(path: &Path) -> bool {
    let name = match path.file_name().and_then(|n| n.to_str()) {
        Some(n) => n.to_ascii_lowercase(),
        None => return false,
    };

    // dont pick up stuff we already made
    if name.contains(".tmp-compressed.")
        || name.contains("-squeezed")
        || name.contains(".squeeze-backup.")
    {
        return false;
    }

    let ext = match path.extension().and_then(|e| e.to_str()) {
        Some(e) => e.to_ascii_lowercase(),
        None => return false,
    };

    VIDEO_EXTENSIONS.iter().any(|ok| *ok == ext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_squeezed_names() {
        assert!(!is_source_video(Path::new("clip-squeezed.mp4")));
        assert!(!is_source_video(Path::new("clip.tmp-compressed.mp4")));
        assert!(is_source_video(Path::new("clip.mp4")));
        assert!(is_source_video(Path::new("CLIP.MKV")));
    }

    #[test]
    fn path_keys_match_slash_and_case() {
        assert!(same_path(r"C:\Clips\Peak\a.mp4", r"c:/clips/peak/a.mp4"));
    }
}
