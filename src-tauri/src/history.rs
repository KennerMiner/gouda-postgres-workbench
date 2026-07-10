//! Persistent query history, stored in SQLite under the app data dir.
//!
//! Every statement executed through `run_query` is recorded — sql text,
//! connection label, timing, row count, and error if any. Kept to the last
//! 5000 entries.

use rusqlite::Connection;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

const KEEP: u32 = 5000;

pub struct History(Mutex<Connection>);

impl History {
    pub fn init(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&dir)?;
        let conn = Connection::open(dir.join("history.db"))?;
        conn.execute_batch(
            "create table if not exists history (
                 id          integer primary key,
                 conn_label  text not null,
                 sql         text not null,
                 started_at  integer not null,
                 elapsed_ms  integer,
                 row_count   integer,
                 error       text
             );
             create index if not exists history_started on history(started_at desc);",
        )?;
        Ok(Self(Mutex::new(conn)))
    }
}

/// Best-effort insert; history must never break query execution.
pub fn record(
    history: &History,
    conn_label: &str,
    sql: &str,
    started_at: i64,
    elapsed_ms: Option<i64>,
    row_count: Option<i64>,
    error: Option<&str>,
) {
    let Ok(conn) = history.0.lock() else { return };
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

#[tauri::command]
pub fn history_list(
    state: State<'_, History>,
    search: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<HistoryEntry>, String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
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
pub fn history_clear(state: State<'_, History>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| e.to_string())?;
    conn.execute("delete from history", [])
        .map(|_| ())
        .map_err(|e| e.to_string())
}
