//! Connection profiles. Metadata lives in the shared SQLite store; passwords
//! live in the macOS Keychain under service "Gouda", account "profile-<id>".

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::{ConnInfo, Connections};
use crate::store::Store;

const KEYCHAIN_SERVICE: &str = "Gouda";

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
    #[serde(default)]
    pub ssh_enabled: bool,
    #[serde(default)]
    pub ssh_host: String,
    #[serde(default = "default_ssh_port")]
    pub ssh_port: u16,
    #[serde(default)]
    pub ssh_user: String,
    /// Empty = use SSH agent, then default key files.
    #[serde(default)]
    pub ssh_key_path: String,
    /// Open sessions read-only (default_transaction_read_only = on).
    #[serde(default)]
    pub read_only: bool,
    /// "disable" | "require" | "verify-full".
    #[serde(default = "default_ssl_mode")]
    pub ssl_mode: String,
}

fn default_ssl_mode() -> String {
    "disable".into()
}

fn default_ssh_port() -> u16 {
    22
}

/// Build the Postgres config (and tunnel, when SSH is enabled) for a profile.
pub(crate) async fn prepare(
    profile: &Profile,
    password: Option<String>,
) -> Result<(tokio_postgres::Config, Option<crate::tunnel::Tunnel>), String> {
    let mut tunnel = None;
    let (host, port) = if profile.ssh_enabled {
        let key_path = profile.ssh_key_path.trim();
        let key_path = if key_path.is_empty() {
            None
        } else {
            Some(key_path.replacen('~', &std::env::var("HOME").unwrap_or_default(), 1))
        };
        let t = crate::tunnel::open(
            crate::tunnel::SshParams {
                host: profile.ssh_host.clone(),
                port: profile.ssh_port,
                user: profile.ssh_user.clone(),
                key_path,
            },
            profile.host.clone(),
            profile.port,
        )
        .await?;
        let local = t.local_port;
        tunnel = Some(t);
        ("127.0.0.1".to_string(), local)
    } else {
        (profile.host.clone(), profile.port)
    };

    let mut config = tokio_postgres::Config::new();
    config
        .host(&host)
        .port(port)
        .dbname(&profile.dbname)
        .user(&profile.username)
        .ssl_mode(match crate::db::SslChoice::parse(&profile.ssl_mode) {
            crate::db::SslChoice::Disable => tokio_postgres::config::SslMode::Disable,
            _ => tokio_postgres::config::SslMode::Require,
        });
    if let Some(pw) = password {
        config.password(&pw);
    }
    Ok((config, tunnel))
}

pub(crate) fn profiles_list_inner(store: &Store) -> Result<Vec<Profile>, String> {
    let conn = store.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "select id, name, host, port, dbname, username, color, last_used_at,
                    ssh_enabled, ssh_host, ssh_port, ssh_user, ssh_key_path, read_only,
                    ssl_mode
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
                ssh_enabled: r.get(8)?,
                ssh_host: r.get(9)?,
                ssh_port: r.get(10)?,
                ssh_user: r.get(11)?,
                ssh_key_path: r.get(12)?,
                read_only: r.get(13)?,
                ssl_mode: r.get(14)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn profiles_list(store: State<'_, Store>) -> Result<Vec<Profile>, String> {
    profiles_list_inner(&store)
}

pub(crate) fn profile_save_inner(
    store: &Store,
    profile: Profile,
    password: Option<String>,
) -> Result<i64, String> {
    let conn = store.0.lock().map_err(|e| e.to_string())?;
    let id = match profile.id {
        Some(id) => {
            conn.execute(
                "update profiles
                 set name = ?1, host = ?2, port = ?3, dbname = ?4, username = ?5, color = ?6,
                     ssh_enabled = ?7, ssh_host = ?8, ssh_port = ?9, ssh_user = ?10,
                     ssh_key_path = ?11, read_only = ?12, ssl_mode = ?13
                 where id = ?14",
                rusqlite::params![
                    profile.name,
                    profile.host,
                    profile.port,
                    profile.dbname,
                    profile.username,
                    profile.color,
                    profile.ssh_enabled,
                    profile.ssh_host,
                    profile.ssh_port,
                    profile.ssh_user,
                    profile.ssh_key_path,
                    profile.read_only,
                    profile.ssl_mode,
                    id
                ],
            )
            .map_err(|e| e.to_string())?;
            id
        }
        None => {
            conn.execute(
                "insert into profiles (name, host, port, dbname, username, color,
                                       ssh_enabled, ssh_host, ssh_port, ssh_user, ssh_key_path,
                                       read_only, ssl_mode)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                rusqlite::params![
                    profile.name,
                    profile.host,
                    profile.port,
                    profile.dbname,
                    profile.username,
                    profile.color,
                    profile.ssh_enabled,
                    profile.ssh_host,
                    profile.ssh_port,
                    profile.ssh_user,
                    profile.ssh_key_path,
                    profile.read_only,
                    profile.ssl_mode
                ],
            )
            .map_err(|e| e.to_string())?;
            conn.last_insert_rowid()
        }
    };
    drop(conn);
    if let Some(pw) = password {
        set_password(id, &pw)?;
    }
    Ok(id)
}

/// Insert or update a profile. `password: Some(_)` writes the Keychain;
/// `None` leaves the stored secret untouched (edit-without-retyping).
#[tauri::command]
pub fn profile_save(
    store: State<'_, Store>,
    profile: Profile,
    password: Option<String>,
) -> Result<i64, String> {
    profile_save_inner(&store, profile, password)
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

    // _tunnel must outlive the client so the bridge stays up for the handshake.
    let ssl = crate::db::SslChoice::parse(&profile.ssl_mode);
    let (mut config, _tunnel) = prepare(&profile, pw).await?;
    config.connect_timeout(std::time::Duration::from_secs(5));

    let client = crate::db::pg_connect(&config, ssl).await?;
    let row = client
        .query_one("select current_setting('server_version')", &[])
        .await
        .map_err(|e| crate::db::pg_err(&e))?;
    let version: String = row.get(0);
    let via = match (profile.ssh_enabled, ssl != crate::db::SslChoice::Disable) {
        (true, true) => " (via SSH, TLS)",
        (true, false) => " (via SSH)",
        (false, true) => " (TLS)",
        (false, false) => "",
    };
    Ok(format!("PostgreSQL {version}{via}"))
}

/// Load a profile row + its Keychain secret. Shared by connect and AI explore.
pub(crate) fn load_profile_with_password(
    store: &Store,
    profile_id: i64,
) -> Result<(Profile, Option<String>), String> {
    let profile = {
        let conn = store.0.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "select id, name, host, port, dbname, username, color, last_used_at,
                    ssh_enabled, ssh_host, ssh_port, ssh_user, ssh_key_path, read_only,
                    ssl_mode
             from profiles where id = ?1",
            [profile_id],
            |r| {
                Ok(Profile {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    host: r.get(2)?,
                    port: r.get(3)?,
                    dbname: r.get(4)?,
                    username: r.get(5)?,
                    color: r.get(6)?,
                    last_used_at: r.get(7)?,
                    ssh_enabled: r.get(8)?,
                    ssh_host: r.get(9)?,
                    ssh_port: r.get(10)?,
                    ssh_user: r.get(11)?,
                    ssh_key_path: r.get(12)?,
                    read_only: r.get(13)?,
                    ssl_mode: r.get(14)?,
                })
            },
        )
        .map_err(|e| format!("profile: {e}"))?
    };
    let password = get_password(profile_id)?;
    Ok((profile, password))
}

/// Connect using a saved profile. The password is resolved from the Keychain
/// in Rust — it never transits the frontend.
#[tauri::command]
pub async fn connect_profile(
    connections: State<'_, Connections>,
    store: State<'_, Store>,
    profile_id: i64,
) -> Result<ConnInfo, String> {
    let (profile, password) = load_profile_with_password(&store, profile_id)?;

    let ssl = crate::db::SslChoice::parse(&profile.ssl_mode);
    let (config, tunnel) = prepare(&profile, password).await?;
    let info = crate::db::open_config(&connections, config, tunnel, ssl).await?;

    if profile.read_only {
        let entry = connections.entry(info.conn_id).await?;
        entry.set_read_only(true).await?;
    }

    let conn = store.0.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "update profiles set last_used_at = ?1 where id = ?2",
        rusqlite::params![chrono::Utc::now().timestamp_millis(), profile_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(info)
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::temp_store;

    fn full_profile() -> Profile {
        Profile {
            id: None,
            name: "rt".into(),
            host: "db.example.com".into(),
            port: 5433,
            dbname: "appdb".into(),
            username: "svc".into(),
            color: "red".into(),
            last_used_at: None,
            ssh_enabled: true,
            ssh_host: "bastion.example.com".into(),
            ssh_port: 2222,
            ssh_user: "jump".into(),
            ssh_key_path: "~/.ssh/id_test".into(),
            read_only: true,
            ssl_mode: "require".into(),
        }
    }

    fn assert_matches(a: &Profile, b: &Profile) {
        assert_eq!(a.name, b.name);
        assert_eq!(a.host, b.host);
        assert_eq!(a.port, b.port);
        assert_eq!(a.dbname, b.dbname);
        assert_eq!(a.username, b.username);
        assert_eq!(a.color, b.color);
        assert_eq!(a.ssh_enabled, b.ssh_enabled);
        assert_eq!(a.ssh_host, b.ssh_host);
        assert_eq!(a.ssh_port, b.ssh_port);
        assert_eq!(a.ssh_user, b.ssh_user);
        assert_eq!(a.ssh_key_path, b.ssh_key_path);
        assert_eq!(a.read_only, b.read_only);
        assert_eq!(a.ssl_mode, b.ssl_mode);
    }

    /// Every profile field must survive insert → list → point-load → update →
    /// reload. This is the regression net for SELECT/mapper/INSERT column
    /// drift (the "Invalid column index" class of bug).
    #[test]
    fn profile_roundtrip_every_field() {
        let store = temp_store();
        let p = full_profile();
        let id = profile_save_inner(&store, p.clone(), None).expect("insert");

        let list = profiles_list_inner(&store).expect("list");
        assert_eq!(list.len(), 1);
        assert_matches(&list[0], &p);
        assert_eq!(list[0].id, Some(id));

        let (loaded, _password) = load_profile_with_password(&store, id).expect("load");
        assert_matches(&loaded, &p);
        // NB: no assertion on the password — the Keychain is machine-global
        // and keyed by profile id, so a developer's real entries may collide
        // with temp-store ids. The load path is exercised either way.

        // Update path: change every mutable field and round-trip again.
        let mut p2 = full_profile();
        p2.id = Some(id);
        p2.name = "rt2".into();
        p2.host = "other.example.com".into();
        p2.port = 6432;
        p2.color = "blue".into();
        p2.ssh_enabled = false;
        p2.read_only = false;
        p2.ssl_mode = "verify-full".into();
        profile_save_inner(&store, p2.clone(), None).expect("update");

        let (reloaded, _) = load_profile_with_password(&store, id).expect("reload");
        assert_matches(&reloaded, &p2);
        assert_eq!(profiles_list_inner(&store).expect("list2").len(), 1);
    }
}
