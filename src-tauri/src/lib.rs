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
            db::run_query,
            db::exec_simple,
            db::explain_query,
            edits::apply_changes,
            history::history_list,
            history::history_clear,
            snippets::snippet_list,
            snippets::snippet_save,
            snippets::snippet_delete,
            write_file,
            profiles::profiles_list,
            profiles::profile_save,
            profiles::profile_delete,
            profiles::test_connection,
            profiles::connect_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
