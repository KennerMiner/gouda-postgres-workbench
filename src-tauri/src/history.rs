//! Persistent query history, in the shared SQLite store.
//!
//! Every statement executed through `run_query` is recorded — sql text,
//! connection label, timing, row count, and error if any. Kept to the last
//! 5000 entries.

use serde::Serialize;
use tauri::State;

use crate::store::Store;

const KEEP: u32 = 5000;

/// Best-effort insert; history must never break query execution.
pub fn record(
    store: &Store,
    conn_label: &str,
    sql: &str,
    started_at: i64,
    elapsed_ms: Option<i64>,
    row_count: Option<i64>,
    error: Option<&str>,
) {
    let Ok(conn) = store.0.lock() else { return };
    let res = conn
        .execute(
            "insert into history (conn_label, sql, started_at, elapsed_ms, row_count, error)
             values (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![conn_label, sql, started_at, elapsed_ms, row_count, error],
        )
        .and_then(|_| {
            conn.execute(
                "delete from history where id not in
                     (select id from history order by id desc limit ?1)",
                [KEEP],
            )
        });
    if let Err(e) = res {
        eprintln!("history record failed: {e}");
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    id: i64,
    conn_label: String,
    sql: String,
    started_at: i64,
    elapsed_ms: Option<i64>,
    row_count: Option<i64>,
    error: Option<String>,
}

pub(crate) fn history_list_inner(
    store: &Store,
    search: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<HistoryEntry>, String> {
    let conn = store.0.lock().map_err(|e| e.to_string())?;
    let limit = limit.unwrap_or(200).min(1000);
    let pattern = search
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!("%{}%", s.trim()));

    let mut stmt = conn
        .prepare(
            "select id, conn_label, sql, started_at, elapsed_ms, row_count, error
             from history
             where ?1 is null or sql like ?1
             order by id desc limit ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![pattern, limit], |r| {
            Ok(HistoryEntry {
                id: r.get(0)?,
                conn_label: r.get(1)?,
                sql: r.get(2)?,
                started_at: r.get(3)?,
                elapsed_ms: r.get(4)?,
                row_count: r.get(5)?,
                error: r.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn history_list(
    store: State<'_, Store>,
    search: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<HistoryEntry>, String> {
    history_list_inner(&store, search, limit)
}

#[tauri::command]
pub fn history_clear(store: State<'_, Store>) -> Result<(), String> {
    let conn = store.0.lock().map_err(|e| e.to_string())?;
    conn.execute("delete from history", [])
        .map(|_| ())
        .map_err(|e| e.to_string())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_store;

    #[test]
    fn record_list_search() {
        let store = temp_store();
        record(&store, "a@x/db", "select 1;", 1000, Some(5), Some(1), None);
        record(&store, "a@x/db", "update t set x = 2;", 2000, Some(9), None, Some("boom"));

        let all = history_list_inner(&store, None, None).unwrap();
        assert_eq!(all.len(), 2);
        // newest first
        assert!(all[0].sql.starts_with("update"));
        assert_eq!(all[0].error.as_deref(), Some("boom"));

        let hits = history_list_inner(&store, Some("select".into()), None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].row_count, Some(1));

        let none = history_list_inner(&store, Some("zzz".into()), None).unwrap();
        assert!(none.is_empty());
    }
}
