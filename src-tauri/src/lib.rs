mod error;
mod media;
mod models;

use std::path::Path;

use error::AppError;
use models::Media;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Frontend calls this with a file path. We probe it and send Media back.
#[tauri::command]
async fn probe_media(path: String) -> Result<Media, AppError> {
    media::ffprobe::probe(Path::new(&path)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, probe_media])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
