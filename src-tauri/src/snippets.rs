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

pub(crate) fn snippet_list_inner(store: &Store) -> Result<Vec<Snippet>, String> {
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

#[tauri::command]
pub fn snippet_list(store: State<'_, Store>) -> Result<Vec<Snippet>, String> {
    snippet_list_inner(&store)
}

pub(crate) fn snippet_save_inner(store: &Store, name: &str, sql: &str) -> Result<(), String> {
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

/// Upsert by name — saving under an existing name replaces that snippet.
#[tauri::command]
pub fn snippet_save(store: State<'_, Store>, name: String, sql: String) -> Result<(), String> {
    snippet_save_inner(&store, &name, &sql)
}

#[tauri::command]
pub fn snippet_delete(store: State<'_, Store>, snippet_id: i64) -> Result<(), String> {
    let conn = store.0.lock().map_err(|e| e.to_string())?;
    conn.execute("delete from snippets where id = ?1", [snippet_id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_store;

    #[test]
    fn snippet_crud_and_upsert() {
        let store = temp_store();
        snippet_save_inner(&store, "retention", "select 1;").unwrap();
        snippet_save_inner(&store, "retention", "select 2;").unwrap(); // upsert
        snippet_save_inner(&store, "  spaced  ", "select 3;").unwrap(); // trimmed
        assert!(snippet_save_inner(&store, "   ", "x").is_err());

        let list = snippet_list_inner(&store).unwrap();
        assert_eq!(list.len(), 2);
        let retention = list.iter().find(|s| s.name == "retention").unwrap();
        assert_eq!(retention.sql, "select 2;");
        assert!(list.iter().any(|s| s.name == "spaced"));
    }
}
