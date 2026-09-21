use std::path::{Path, PathBuf};

// where we write midencode junk and the final "copy beside original" file

pub fn temp_path(input: &Path) -> PathBuf {
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    input.with_file_name(format!("{stem}.tmp-compressed.mp4"))
}

pub fn beside_original(input: &Path) -> PathBuf {
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("video");
    input.with_file_name(format!("{stem}-squeezed.mp4"))
}
