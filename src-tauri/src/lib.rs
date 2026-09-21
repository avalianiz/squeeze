mod error;
mod filesystem;
mod media;
mod models;

use std::path::Path;

use error::AppError;
use models::{CompressResult, CompressionSettings, Media};

#[tauri::command]
async fn probe_media(path: String) -> Result<Media, AppError> {
    media::ffprobe::probe(Path::new(&path)).await
}

// compress one file to ~19.5mb next to the original
#[tauri::command]
async fn compress_media(path: String) -> Result<CompressResult, AppError> {
    media::ffmpeg::compress(Path::new(&path), &CompressionSettings::discord()).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![probe_media, compress_media])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
