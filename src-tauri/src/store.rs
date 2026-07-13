//! Shared local SQLite store (app-data dir): query history + connection
//! profiles. Passwords never live here — they go to the macOS Keychain.

use rusqlite::Connection;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub struct Store(pub Mutex<Connection>);

impl Store {
    pub fn init(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let dir = app.path().app_data_dir()?;
        Self::init_at(&dir)
    }

    /// Path-based constructor so tests can build a real store in a temp dir.
    pub fn init_at(dir: &std::path::Path) -> Result<Self, Box<dyn std::error::Error>> {
        std::fs::create_dir_all(dir)?;
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
             create index if not exists history_started on history(started_at desc);

             create table if not exists profiles (
                 id           integer primary key,
                 name         text not null unique,
                 host         text not null default 'localhost',
                 port         integer not null default 5432,
                 dbname       text not null,
                 username     text not null,
                 color        text not null default 'green',
                 last_used_at integer
             );",
        )?;

        // Additive migrations: ignore "duplicate column" on re-run.
        for stmt in [
            "alter table profiles add column ssh_enabled integer not null default 0",
            "alter table profiles add column ssh_host text not null default ''",
            "alter table profiles add column ssh_port integer not null default 22",
            "alter table profiles add column ssh_user text not null default ''",
            "alter table profiles add column ssh_key_path text not null default ''",
            "alter table profiles add column read_only integer not null default 0",
            "alter table profiles add column ssl_mode text not null default 'disable'",
        ] {
            let _ = conn.execute(stmt, []);
        }

        conn.execute_batch(
            "create table if not exists snippets (
                 id   integer primary key,
                 name text not null unique,
                 sql  text not null
             );
             create table if not exists app_state (
                 key   text primary key,
                 value text not null
             );",
        )?;

        // First run: no profiles — the frontend opens the connection manager.
        Ok(Self(Mutex::new(conn)))
    }
}

pub(crate) fn state_get_inner(store: &Store, key: &str) -> Result<Option<String>, String> {
    let conn = store.0.lock().map_err(|e| e.to_string())?;
    conn.query_row("select value from app_state where key = ?1", [key], |r| r.get(0))
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            e => Err(e.to_string()),
        })
}

pub(crate) fn state_set_inner(store: &Store, key: &str, value: &str) -> Result<(), String> {
    let conn = store.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "insert into app_state (key, value) values (?1, ?2)
         on conflict(key) do update set value = excluded.value",
        rusqlite::params![key, value],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Generic UI state persistence (session tabs, window prefs, …).
#[tauri::command]
pub fn state_get(store: State<'_, Store>, key: String) -> Result<Option<String>, String> {
    state_get_inner(&store, &key)
}

#[tauri::command]
pub fn state_set(store: State<'_, Store>, key: String, value: String) -> Result<(), String> {
    state_set_inner(&store, &key, &value)
}

#[cfg(test)]
pub(crate) fn temp_store() -> Store {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "gouda-test-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    Store::init_at(&dir).expect("temp store")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_kv_roundtrip() {
        let store = temp_store();
        assert_eq!(state_get_inner(&store, "missing").unwrap(), None);
        state_set_inner(&store, "k", "v1").unwrap();
        assert_eq!(state_get_inner(&store, "k").unwrap(), Some("v1".into()));
        state_set_inner(&store, "k", "v2").unwrap(); // upsert
        assert_eq!(state_get_inner(&store, "k").unwrap(), Some("v2".into()));
    }

    #[test]
    fn migrations_are_idempotent() {
        // init_at on an existing dir must not error (alters ignored).
        let dir = std::env::temp_dir().join(format!("gouda-idem-{}", std::process::id()));
        let _ = Store::init_at(&dir).expect("first");
        let _ = Store::init_at(&dir).expect("second");
    }
}
