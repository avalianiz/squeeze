use std::path::{Path, PathBuf};

use crate::filesystem::discovery::same_path;

pub fn temp_path(input: &Path) -> PathBuf {
    let stem = stem(input);
    input.with_file_name(format!("{stem}.tmp-compressed.mp4"))
}

pub fn beside_original(input: &Path, output_name: Option<&str>, suffix: &str) -> PathBuf {
    let stem = resolve_stem(input, output_name);
    input.with_file_name(format!("{stem}{suffix}.mp4"))
}

pub fn beside_original_unique(input: &Path, output_name: Option<&str>, suffix: &str) -> PathBuf {
    let first = beside_original(input, output_name, suffix);
    if is_usable_output(&first, input) {
        return first;
    }

    let stem = resolve_stem(input, output_name);
    let parent = input.parent().unwrap_or_else(|| Path::new("."));
    for n in 2..10_000 {
        let candidate = parent.join(format!("{stem}{suffix}-{n}.mp4"));
        if is_usable_output(&candidate, input) {
            return candidate;
        }
    }

    parent.join(format!(
        "{stem}{suffix}-{}.mp4",
        uuid::Uuid::new_v4()
    ))
}

fn is_usable_output(candidate: &Path, input: &Path) -> bool {
    !paths_equal(candidate, input) && !candidate.exists()
}

fn paths_equal(a: &Path, b: &Path) -> bool {
    same_path(&a.to_string_lossy(), &b.to_string_lossy())
}

pub fn backup_path(input: &Path) -> PathBuf {
    let stem = stem(input);
    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4");
    input.with_file_name(format!("{stem}.squeeze-backup.{ext}"))
}

pub fn replace_final_path(input: &Path, output_name: Option<&str>) -> PathBuf {
    match output_name {
        Some(name) => {
            let stem = sanitize_stem(name);
            input.with_file_name(format!("{stem}.mp4"))
        }
        None => input.with_extension("mp4"),
    }
}

fn stem(input: &Path) -> String {
    input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video")
        .to_string()
}

fn resolve_stem(input: &Path, output_name: Option<&str>) -> String {
    match output_name {
        Some(name) => sanitize_stem(name),
        None => stem(input),
    }
}

pub fn sanitize_stem(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "video".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_keeps_mp4_name() {
        assert_eq!(
            replace_final_path(Path::new(r"C:\vids\clip.mov"), None),
            PathBuf::from(r"C:\vids\clip.mp4")
        );
    }

    #[test]
    fn custom_name_sanitizes() {
        assert_eq!(sanitize_stem("cool/clip:1"), "cool-clip-1");
        assert_eq!(
            beside_original(Path::new(r"C:\vids\a.mp4"), Some("my clip"), "-squeezed"),
            PathBuf::from(r"C:\vids\my clip-squeezed.mp4")
        );
    }

    #[test]
    fn beside_never_returns_input_path() {
        let input = Path::new(r"C:\vids\clip-squeezed.mp4");
        let dest = beside_original_unique(input, Some("clip"), "-squeezed");
        assert!(!paths_equal(&dest, input));
        assert_eq!(dest, PathBuf::from(r"C:\vids\clip-squeezed-2.mp4"));
    }
}
