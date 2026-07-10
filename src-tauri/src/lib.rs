mod db;
mod history;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(db::Connections::default())
        .setup(|app| {
            let h = history::History::init(app.handle())?;
            app.manage(h);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db::connect,
            db::cancel_query,
            db::disconnect,
            db::list_objects,
            db::run_query,
            history::history_list,
            history::history_clear
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
