//! LISTEN/NOTIFY console. A dedicated session per connection owns its
//! Connection object (the normal driver task discards async messages) and
//! forwards notifications to the frontend as Tauri events.

use std::collections::{HashMap, HashSet};

use futures::future::poll_fn;
use tauri::Emitter;
use tokio::sync::Mutex;
use tokio_postgres::{AsyncMessage, Client};

use crate::db::Connections;

struct ListenerState {
    client: Client,
    channels: HashSet<String>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for ListenerState {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Default)]
pub struct Listeners(Mutex<HashMap<u32, ListenerState>>);

/// Drive the connection, forwarding NOTIFY messages as Tauri events.
fn spawn_forwarder<S, T>(
    mut connection: tokio_postgres::Connection<S, T>,
    app: tauri::AppHandle,
    conn_id: u32,
) -> tokio::task::JoinHandle<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        loop {
            match poll_fn(|cx| connection.poll_message(cx)).await {
                Some(Ok(AsyncMessage::Notification(n))) => {
                    let _ = app.emit(
                        "pg-notify",
                        serde_json::json!({
                            "connId": conn_id,
                            "channel": n.channel(),
                            "payload": n.payload(),
                            "pid": n.process_id(),
                        }),
                    );
                }
                Some(Ok(_)) => {}
                Some(Err(_)) | None => break,
            }
        }
    })
}

fn valid_channel(c: &str) -> bool {
    !c.is_empty()
        && c.len() <= 63
        && c.chars().next().is_some_and(|f| f.is_ascii_alphabetic() || f == '_')
        && c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

/// Subscribe this connection to a NOTIFY channel; events arrive in the
/// frontend as "pg-notify" { connId, channel, payload, pid }.
#[tauri::command]
pub async fn listen_start(
    app: tauri::AppHandle,
    connections: tauri::State<'_, Connections>,
    listeners: tauri::State<'_, Listeners>,
    conn_id: u32,
    channel: String,
) -> Result<(), String> {
    if !valid_channel(&channel) {
        return Err("channel names: letters, digits, underscores (start with a letter)".into());
    }
    let entry = connections.entry(conn_id).await?;
    let mut map = listeners.0.lock().await;

    if !map.contains_key(&conn_id) || map.get(&conn_id).is_some_and(|l| l.client.is_closed()) {
        map.remove(&conn_id);
        let cfg = entry.listen_config();
        let (client, task) = match crate::db::make_tls(entry.ssl())? {
            None => {
                let (client, connection) = cfg
                    .connect(tokio_postgres::NoTls)
                    .await
                    .map_err(|e| format!("listener connect: {}", crate::db::pg_err(&e)))?;
                (client, spawn_forwarder(connection, app.clone(), conn_id))
            }
            Some(tls) => {
                let (client, connection) = cfg
                    .connect(tls)
                    .await
                    .map_err(|e| format!("listener connect (tls): {}", crate::db::pg_err(&e)))?;
                (client, spawn_forwarder(connection, app.clone(), conn_id))
            }
        };
        map.insert(
            conn_id,
            ListenerState {
                client,
                channels: HashSet::new(),
                task,
            },
        );
    }

    let state = map.get_mut(&conn_id).unwrap();
    state
        .client
        .batch_execute(&format!("listen \"{channel}\""))
        .await
        .map_err(|e| crate::db::pg_err(&e))?;
    state.channels.insert(channel);
    Ok(())
}

#[tauri::command]
pub async fn listen_stop(
    listeners: tauri::State<'_, Listeners>,
    conn_id: u32,
    channel: String,
) -> Result<(), String> {
    if !valid_channel(&channel) {
        return Err("invalid channel name".into());
    }
    let mut map = listeners.0.lock().await;
    if let Some(state) = map.get_mut(&conn_id) {
        let _ = state
            .client
            .batch_execute(&format!("unlisten \"{channel}\""))
            .await;
        state.channels.remove(&channel);
        if state.channels.is_empty() {
            map.remove(&conn_id); // Drop aborts the poll task.
        }
    }
    Ok(())
}

/// Convenience sender so the console can test itself (and other apps).
#[tauri::command]
pub async fn notify_send(
    connections: tauri::State<'_, Connections>,
    conn_id: u32,
    channel: String,
    payload: String,
) -> Result<(), String> {
    let entry = connections.entry(conn_id).await?;
    entry
        .client()
        .execute("select pg_notify($1, $2)", &[&channel, &payload])
        .await
        .map(|_| ())
        .map_err(|e| crate::db::pg_err(&e))
}


#[cfg(test)]
mod tests {
    use super::valid_channel;

    #[test]
    fn channel_validation() {
        assert!(valid_channel("cache_invalidation"));
        assert!(valid_channel("_private"));
        assert!(valid_channel("ch4nnel"));
        assert!(!valid_channel(""));
        assert!(!valid_channel("1starts_with_digit"));
        assert!(!valid_channel("has-dash"));
        assert!(!valid_channel("has space"));
        assert!(!valid_channel("quote\"inject"));
        assert!(!valid_channel(&"x".repeat(64)));
    }
}
