//! Shared local SQLite store (app-data dir): query history + connection
//! profiles. Passwords never live here — they go to the macOS Keychain.

use rusqlite::Connection;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub struct Store(pub Mutex<Connection>);

impl Store {
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
        ] {
            let _ = conn.execute(stmt, []);
        }

        // First run: seed the local dev profile so the app stays a
        // zero-config daily driver. Password goes to the Keychain.
        let empty: bool =
            conn.query_row("select count(*) = 0 from profiles", [], |r| r.get(0))?;
        if empty {
            conn.execute(
                "insert into profiles (name, host, port, dbname, username, color)
                 values ('heroage local', 'localhost', 5432, 'heroage', 'heroage', 'green')",
                [],
            )?;
            let id: i64 = conn.query_row("select id from profiles", [], |r| r.get(0))?;
            if let Err(e) = crate::profiles::set_password(id, "heroage") {
                eprintln!("seed keychain write failed: {e}");
            }
        }

        Ok(Self(Mutex::new(conn)))
    }
}
