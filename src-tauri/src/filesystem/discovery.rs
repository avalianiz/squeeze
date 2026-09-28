use std::path::{Path, PathBuf};

use crate::error::AppError;

pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "mov", "webm", "avi", "m4v", "wmv", "flv",
];

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

pub fn discover_videos(root: &Path) -> Result<Vec<PathBuf>, AppError> {
    if !root.is_dir() {
        return Err(AppError::InputNotFound(root.display().to_string()));
    }

    let mut found = Vec::new();
    let entries = std::fs::read_dir(root).map_err(|e| {
        AppError::Io(format!("cant read {}: {e}", root.display()))
    })?;

    for entry in entries {
        let entry = entry.map_err(|e| AppError::Io(e.to_string()))?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|e| AppError::Io(e.to_string()))?;

        if file_type.is_file() && is_source_video(&path) {
            found.push(path);
        }
    }

    found.sort();
    Ok(found)
}

pub fn is_supported_video(path: &Path) -> bool {
    is_source_video(path)
}

fn is_source_video(path: &Path) -> bool {
    let name = match path.file_name().and_then(|n| n.to_str()) {
        Some(n) => n.to_ascii_lowercase(),
        None => return false,
    };

    if is_squeeze_generated_name(&name) {
        return false;
    }

    let ext = match path.extension().and_then(|e| e.to_str()) {
        Some(e) => e.to_ascii_lowercase(),
        None => return false,
    };

    VIDEO_EXTENSIONS.iter().any(|ok| *ok == ext)
}

fn is_squeeze_generated_name(file_name_lower: &str) -> bool {
    if file_name_lower.contains(".tmp-compressed.")
        || file_name_lower.contains(".squeeze-backup.")
    {
        return true;
    }

    let stem = match file_name_lower.rsplit_once('.') {
        Some((stem, _)) => stem,
        None => file_name_lower,
    };

    stem_has_generated_suffix(stem, "-squeezed") || stem_has_generated_suffix(stem, "-trimmed")
}

fn stem_has_generated_suffix(stem: &str, suffix: &str) -> bool {
    if stem.ends_with(suffix) {
        return stem.len() > suffix.len();
    }

    let marker = format!("{suffix}-");
    if let Some(idx) = stem.rfind(&marker) {
        let after = &stem[idx + marker.len()..];
        return !after.is_empty() && after.chars().all(|c| c.is_ascii_digit());
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_squeezed_and_trimmed_outputs() {
        assert!(!is_source_video(Path::new("clip-squeezed.mp4")));
        assert!(!is_source_video(Path::new("clip-squeezed-2.mp4")));
        assert!(!is_source_video(Path::new("clip-trimmed.mp4")));
        assert!(!is_source_video(Path::new("clip-trimmed-3.mp4")));
        assert!(!is_source_video(Path::new("clip.tmp-compressed.mp4")));
        assert!(!is_source_video(Path::new("clip.squeeze-backup.mp4")));
    }

    #[test]
    fn keeps_user_names_with_similar_words() {
        assert!(is_source_video(Path::new("clip.mp4")));
        assert!(is_source_video(Path::new("CLIP.MKV")));
        assert!(is_source_video(Path::new("my-trimmed-clips.mp4")));
        assert!(is_source_video(Path::new("squeezed-raw-take.mp4")));
        assert!(is_source_video(Path::new("clip-trimmed-final.mp4")));
    }

    #[test]
    fn path_keys_match_slash_and_case() {
        assert!(same_path(r"C:\Clips\Peak\a.mp4", r"c:/clips/peak/a.mp4"));
    }
}
