use tauri_plugin_shell::ShellExt;

/// Smoke-test that the bundled ffprobe sidecar is reachable and runs.
/// Returns ffprobe's first version line, or an error string. Temporary —
/// the real pipeline commands replace this in a following commit.
#[tauri::command]
async fn ffprobe_version(app: tauri::AppHandle) -> Result<String, String> {
    let output = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| format!("sidecar not found: {e}"))?
        .args(["-version"])
        .output()
        .await
        .map_err(|e| format!("ffprobe spawn failed: {e}"))?;

    if output.status.success() {
        let text = String::from_utf8_lossy(&output.stdout);
        Ok(text.lines().next().unwrap_or("").to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![ffprobe_version])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
