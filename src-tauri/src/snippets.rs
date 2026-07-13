//! Saved SQL snippets, surfaced through the command palette.

use serde::Serialize;
use tauri::State;

use crate::store::Store;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    id: i64,
    name: String,
    sql: String,
}

#[tauri::command]
pub fn snippet_list(store: State<'_, Store>) -> Result<Vec<Snippet>, String> {
    let conn = store.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("select id, name, sql from snippets order by name")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Snippet {
                id: r.get(0)?,
                name: r.get(1)?,
                sql: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Upsert by name — saving under an existing name replaces that snippet.
#[tauri::command]
pub fn snippet_save(store: State<'_, Store>, name: String, sql: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("snippet name is empty".into());
    }
    let conn = store.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "insert into snippets (name, sql) values (?1, ?2)
         on conflict(name) do update set sql = excluded.sql",
        rusqlite::params![name, sql],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn snippet_delete(store: State<'_, Store>, snippet_id: i64) -> Result<(), String> {
    let conn = store.0.lock().map_err(|e| e.to_string())?;
    conn.execute("delete from snippets where id = ?1", [snippet_id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}
