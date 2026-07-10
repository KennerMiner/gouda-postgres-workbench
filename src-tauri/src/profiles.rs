//! Connection profiles. Metadata lives in the shared SQLite store; passwords
//! live in the macOS Keychain under service "psqlViewer", account "profile-<id>".

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::{ConnInfo, Connections};
use crate::store::Store;

const KEYCHAIN_SERVICE: &str = "psqlViewer";

fn entry(profile_id: i64) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &format!("profile-{profile_id}"))
        .map_err(|e| format!("keychain: {e}"))
}

pub fn set_password(profile_id: i64, password: &str) -> Result<(), String> {
    entry(profile_id)?
        .set_password(password)
        .map_err(|e| format!("keychain: {e}"))
}

fn get_password(profile_id: i64) -> Result<Option<String>, String> {
    match entry(profile_id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain: {e}")),
    }
}

fn delete_password(profile_id: i64) {
    if let Ok(e) = entry(profile_id) {
        let _ = e.delete_credential();
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: Option<i64>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub dbname: String,
    pub username: String,
    pub color: String,
    pub last_used_at: Option<i64>,
}

#[tauri::command]
pub fn profiles_list(store: State<'_, Store>) -> Result<Vec<Profile>, String> {
    let conn = store.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "select id, name, host, port, dbname, username, color, last_used_at
             from profiles order by last_used_at desc nulls last, name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Profile {
                id: r.get(0)?,
                name: r.get(1)?,
                host: r.get(2)?,
                port: r.get(3)?,
                dbname: r.get(4)?,
                username: r.get(5)?,
                color: r.get(6)?,
                last_used_at: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Insert or update a profile. `password: Some(_)` writes the Keychain;
/// `None` leaves the stored secret untouched (edit-without-retyping).
#[tauri::command]
pub fn profile_save(
    store: State<'_, Store>,
    profile: Profile,
    password: Option<String>,
) -> Result<i64, String> {
    let conn = store.0.lock().map_err(|e| e.to_string())?;
    let id = match profile.id {
        Some(id) => {
            conn.execute(
                "update profiles
                 set name = ?1, host = ?2, port = ?3, dbname = ?4, username = ?5, color = ?6
                 where id = ?7",
                rusqlite::params![
                    profile.name,
                    profile.host,
                    profile.port,
                    profile.dbname,
                    profile.username,
                    profile.color,
                    id
                ],
            )
            .map_err(|e| e.to_string())?;
            id
        }
        None => {
            conn.execute(
                "insert into profiles (name, host, port, dbname, username, color)
                 values (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    profile.name,
                    profile.host,
                    profile.port,
                    profile.dbname,
                    profile.username,
                    profile.color
                ],
            )
            .map_err(|e| e.to_string())?;
            conn.last_insert_rowid()
        }
    };
    if let Some(pw) = password {
        set_password(id, &pw)?;
    }
    Ok(id)
}

#[tauri::command]
pub fn profile_delete(store: State<'_, Store>, profile_id: i64) -> Result<(), String> {
    let conn = store.0.lock().map_err(|e| e.to_string())?;
    conn.execute("delete from profiles where id = ?1", [profile_id])
        .map_err(|e| e.to_string())?;
    delete_password(profile_id);
    Ok(())
}

/// Try the given form values without touching the active connection or the
/// saved profile. `password: None` falls back to the Keychain secret for
/// already-saved profiles (so "Test" works without retyping).
#[tauri::command]
pub async fn test_connection(profile: Profile, password: Option<String>) -> Result<String, String> {
    let pw = match password {
        Some(p) => Some(p),
        None => match profile.id {
            Some(id) => get_password(id)?,
            None => None,
        },
    };

    let mut config = tokio_postgres::Config::new();
    config
        .host(&profile.host)
        .port(profile.port)
        .dbname(&profile.dbname)
        .user(&profile.username)
        .connect_timeout(std::time::Duration::from_secs(5));
    if let Some(p) = pw {
        config.password(&p);
    }

    let (client, connection) = config.connect(tokio_postgres::NoTls).await.map_err(|e| format!("{e}"))?;
    let handle = tokio::spawn(connection);
    let row = client
        .query_one("select current_setting('server_version')", &[])
        .await
        .map_err(|e| format!("{e}"))?;
    let version: String = row.get(0);
    drop(client);
    let _ = handle.await;
    Ok(format!("PostgreSQL {version}"))
}

/// Connect using a saved profile. The password is resolved from the Keychain
/// in Rust — it never transits the frontend.
#[tauri::command]
pub async fn connect_profile(
    connections: State<'_, Connections>,
    store: State<'_, Store>,
    profile_id: i64,
) -> Result<ConnInfo, String> {
    // Read the profile + secret before any await so the sync locks are short.
    let (profile, password) = {
        let conn = store.0.lock().map_err(|e| e.to_string())?;
        let profile = conn
            .query_row(
                "select name, host, port, dbname, username from profiles where id = ?1",
                [profile_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, u16>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                },
            )
            .map_err(|e| format!("profile: {e}"))?;
        (profile, get_password(profile_id)?)
    };
    let (_name, host, port, dbname, username) = profile;

    let mut config = tokio_postgres::Config::new();
    config
        .host(&host)
        .port(port)
        .dbname(&dbname)
        .user(&username);
    if let Some(pw) = password {
        config.password(&pw);
    }

    let info = crate::db::open_config(&connections, config).await?;

    let conn = store.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "update profiles set last_used_at = ?1 where id = ?2",
        rusqlite::params![chrono::Utc::now().timestamp_millis(), profile_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(info)
}
