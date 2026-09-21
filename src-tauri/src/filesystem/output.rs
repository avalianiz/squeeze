use std::path::{Path, PathBuf};

// mid-encode junk + final copy / replace paths

pub fn temp_path(input: &Path) -> PathBuf {
    let stem = stem(input);
    input.with_file_name(format!("{stem}.tmp-compressed.mp4"))
}

pub fn beside_original(input: &Path) -> PathBuf {
    let stem = stem(input);
    input.with_file_name(format!("{stem}-squeezed.mp4"))
}

// if foo-squeezed.mp4 exists already, try foo-squeezed-2.mp4 etc
pub fn beside_original_unique(input: &Path) -> PathBuf {
    let first = beside_original(input);
    if !first.exists() {
        return first;
    }

    let stem = stem(input);
    let parent = input.parent().unwrap_or_else(|| Path::new("."));
    for n in 2..10_000 {
        let candidate = parent.join(format!("{stem}-squeezed-{n}.mp4"));
        if !candidate.exists() {
            return candidate;
        }
    }

    parent.join(format!(
        "{stem}-squeezed-{}.mp4",
        uuid::Uuid::new_v4()
    ))
}

pub fn backup_path(input: &Path) -> PathBuf {
    let stem = stem(input);
    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4");
    input.with_file_name(format!("{stem}.squeeze-backup.{ext}"))
}

// replace always lands on .mp4 (thats what we encode)
pub fn replace_final_path(input: &Path) -> PathBuf {
    input.with_extension("mp4")
}

fn stem(input: &Path) -> String {
    input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_keeps_mp4_name() {
        assert_eq!(
            replace_final_path(Path::new(r"C:\vids\clip.mov")),
            PathBuf::from(r"C:\vids\clip.mp4")
        );
    }
}
