// Tauri application entry. The MVP frontend is fully self-contained (mock data,
// scoring, and personalization all run in the webview), so no custom Rust
// commands are needed yet. Native commands (e.g. a scheduled research job or a
// secure provider proxy) would be registered here with `.invoke_handler(...)`.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .run(tauri::generate_context!())
        .expect("error while running Catalyzed Alpha");
}
