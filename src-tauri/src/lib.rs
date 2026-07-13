mod ai;
mod db;
mod edits;
mod history;
mod profiles;
mod snippets;
mod store;
mod tunnel;

use tauri::Manager;

/// Write exported content to a user-chosen path (from the save dialog).
#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("write {path}: {e}"))
}

static WINDOW_COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

/// A fresh window with its own connection — the window boundary is the
/// guard against "oops, wrong server" tab confusion.
#[tauri::command]
async fn open_new_window(app: tauri::AppHandle) -> Result<(), String> {
    let n = WINDOW_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        format!("win-{n}"),
        tauri::WebviewUrl::default(),
    )
    .title("psqlViewer")
    .inner_size(1150.0, 760.0)
    .min_inner_size(720.0, 480.0);
    #[cfg(target_os = "macos")]
    let builder = builder
        .hidden_title(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay);
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(db::Connections::default())
        .setup(|app| {
            let s = store::Store::init(app.handle())?;
            app.manage(s);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::connect,
            db::cancel_query,
            db::disconnect,
            db::list_objects,
            db::schema_catalog,
            db::table_structure,
            db::run_query,
            db::exec_session,
            db::set_read_only,
            db::close_session,
            db::explain_query,
            edits::apply_changes,
            history::history_list,
            history::history_clear,
            snippets::snippet_list,
            snippets::snippet_save,
            snippets::snippet_delete,
            store::state_get,
            store::state_set,
            ai::ai_generate_query,
            ai::ai_explore_context,
            ai::ai_load_context,
            ai::ai_save_context,
            write_file,
            open_new_window,
            profiles::profiles_list,
            profiles::profile_save,
            profiles::profile_delete,
            profiles::test_connection,
            profiles::connect_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
