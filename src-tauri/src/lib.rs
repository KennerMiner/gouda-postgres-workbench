mod db;
mod edits;
mod history;
mod profiles;
mod store;
mod tunnel;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
            edits::apply_changes,
            history::history_list,
            history::history_clear,
            profiles::profiles_list,
            profiles::profile_save,
            profiles::profile_delete,
            profiles::test_connection,
            profiles::connect_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
