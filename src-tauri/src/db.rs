//! Connection registry + query streaming.
//!
//! Connections are opened once via `connect` and reused across queries — a
//! `run_query` call looks up its client by id. Still M1-thin: no TLS, no SSH
//! tunnel, no pooling beyond one client per connection, no cancel yet.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use futures::{pin_mut, StreamExt};
use postgres_types::Type;
use rust_decimal::Decimal;
use serde::Serialize;
use serde_json::Value as J;
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;
use tokio_postgres::{types::ToSql, Client, NoTls, Row};

/// Rows are flushed to the UI in batches of this size so a large result set
/// streams in rather than materializing entirely before the first paint.
const BATCH: usize = 500;

#[derive(Default)]
pub struct Connections {
    next_id: AtomicU32,
    map: Mutex<HashMap<u32, Arc<Client>>>,
}

impl Connections {
    async fn get(&self, id: u32) -> Result<Arc<Client>, String> {
        self.map
            .lock()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("no connection #{id} — reconnect"))
    }

    /// Evict a connection whose socket has died so the UI can reconnect.
    async fn drop_if_closed(&self, id: u32, client: &Client) {
        if client.is_closed() {
            self.map.lock().await.remove(&id);
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnInfo {
    conn_id: u32,
    server_version: String,
    user: String,
    database: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    name: String,
    type_name: String,
    type_oid: u32,
}

/// Streaming protocol sent over the Channel. One `Meta`, then zero or more
/// `Rows`, terminated by exactly one `Done` or one `Error`.
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum QueryEvent {
    Meta { columns: Vec<ColumnMeta> },
    Rows { rows: Vec<Vec<J>> },
    Done { row_count: usize, elapsed_ms: u64 },
    Error { message: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbObject {
    schema: String,
    name: String,
    kind: String,
}

#[tauri::command]
pub async fn connect(state: State<'_, Connections>, dsn: String) -> Result<ConnInfo, String> {
    let (client, connection) = tokio_postgres::connect(&dsn, NoTls)
        .await
        .map_err(|e| format!("connect: {e}"))?;

    // The connection object drives the socket; it must be polled on its own
    // task for the client handle to make progress.
    tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("postgres connection error: {e}");
        }
    });

    let row = client
        .query_one(
            "select current_setting('server_version'), current_user::text, current_database()",
            &[],
        )
        .await
        .map_err(|e| format!("handshake: {e}"))?;

    let conn_id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    state.map.lock().await.insert(conn_id, Arc::new(client));

    Ok(ConnInfo {
        conn_id,
        server_version: row.get(0),
        user: row.get(1),
        database: row.get(2),
    })
}

/// Cancel whatever is currently running on this connection. Postgres cancel
/// goes out-of-band on a fresh socket, so this works while `run_query` is
/// blocked streaming.
#[tauri::command]
pub async fn cancel_query(state: State<'_, Connections>, conn_id: u32) -> Result<(), String> {
    let client = state.get(conn_id).await?;
    client
        .cancel_token()
        .cancel_query(NoTls)
        .await
        .map_err(|e| format!("cancel: {e}"))
}

#[tauri::command]
pub async fn disconnect(state: State<'_, Connections>, conn_id: u32) -> Result<(), String> {
    // Dropping the client closes the socket and ends the driver task.
    state.map.lock().await.remove(&conn_id);
    Ok(())
}

/// Everything the sidebar shows: tables, views, matviews, foreign tables,
/// partitioned tables — grouped client-side by schema.
#[tauri::command]
pub async fn list_objects(
    state: State<'_, Connections>,
    conn_id: u32,
) -> Result<Vec<DbObject>, String> {
    let client = state.get(conn_id).await?;
    let rows = client
        .query(
            r#"select n.nspname,
                      c.relname,
                      case c.relkind
                          when 'r' then 'table'
                          when 'p' then 'table'
                          when 'v' then 'view'
                          when 'm' then 'matview'
                          when 'f' then 'foreign'
                      end
               from pg_class c
               join pg_namespace n on n.oid = c.relnamespace
               where c.relkind in ('r', 'p', 'v', 'm', 'f')
                 and n.nspname not in ('pg_catalog', 'information_schema')
                 and n.nspname not like 'pg_toast%'
               order by 1, 3, 2"#,
            &[],
        )
        .await
        .map_err(|e| format!("list objects: {e}"));
    match rows {
        Ok(rows) => Ok(rows
            .iter()
            .map(|r| DbObject {
                schema: r.get(0),
                name: r.get(1),
                kind: r.get(2),
            })
            .collect()),
        Err(e) => {
            state.drop_if_closed(conn_id, &client).await;
            Err(e)
        }
    }
}

/// Run a single SQL statement on an open connection and stream results.
///
/// Uses the extended protocol (prepare + query_raw), so exactly one statement
/// is supported — multi-statement scripts are a later M1 item (simple_query).
#[tauri::command]
pub async fn run_query(
    state: State<'_, Connections>,
    conn_id: u32,
    sql: String,
    on_event: Channel<QueryEvent>,
) -> Result<(), String> {
    let start = std::time::Instant::now();
    let client = match state.get(conn_id).await {
        Ok(c) => c,
        Err(message) => {
            let _ = on_event.send(QueryEvent::Error { message });
            return Ok(());
        }
    };

    let result: Result<(), String> = async {
        let stmt = client.prepare(&sql).await.map_err(|e| format!("{e}"))?;

        let columns: Vec<ColumnMeta> = stmt
            .columns()
            .iter()
            .map(|c| ColumnMeta {
                name: c.name().to_string(),
                type_name: c.type_().name().to_string(),
                type_oid: c.type_().oid(),
            })
            .collect();
        let ncols = columns.len();
        on_event
            .send(QueryEvent::Meta { columns })
            .map_err(|e| e.to_string())?;

        let params = std::iter::empty::<&(dyn ToSql + Sync)>();
        let stream = client
            .query_raw(&stmt, params)
            .await
            .map_err(|e| format!("{e}"))?;
        pin_mut!(stream);

        let mut batch: Vec<Vec<J>> = Vec::with_capacity(BATCH);
        let mut total = 0usize;
        while let Some(item) = stream.next().await {
            let row = item.map_err(|e| format!("{e}"))?;
            let mut out = Vec::with_capacity(ncols);
            for i in 0..ncols {
                out.push(cell(&row, i));
            }
            batch.push(out);
            total += 1;
            if batch.len() >= BATCH {
                on_event
                    .send(QueryEvent::Rows { rows: std::mem::take(&mut batch) })
                    .map_err(|e| e.to_string())?;
            }
        }
        if !batch.is_empty() {
            on_event
                .send(QueryEvent::Rows { rows: batch })
                .map_err(|e| e.to_string())?;
        }
        on_event
            .send(QueryEvent::Done {
                row_count: total,
                elapsed_ms: start.elapsed().as_millis() as u64,
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;

    if let Err(message) = result {
        let _ = on_event.send(QueryEvent::Error { message });
        state.drop_if_closed(conn_id, &client).await;
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn int_array(v: Vec<Option<i32>>) -> J {
    J::Array(v.into_iter().map(|x| x.map(J::from).unwrap_or(J::Null)).collect())
}

fn bigint_array(v: Vec<Option<i64>>) -> J {
    J::Array(v.into_iter().map(|x| x.map(J::from).unwrap_or(J::Null)).collect())
}

fn text_array(v: Vec<Option<String>>) -> J {
    J::Array(v.into_iter().map(|x| x.map(J::String).unwrap_or(J::Null)).collect())
}

/// Convert a single cell to JSON based on its Postgres type. Unknown types fall
/// back to their text representation when the driver can decode one, otherwise a
/// `<typename>` placeholder — so an unfamiliar type never aborts the whole query.
fn cell(row: &Row, i: usize) -> J {
    let ty = row.columns()[i].type_().clone();

    // try_get returns Option<T> (NULL -> None) and surfaces decode failures as
    // an inline marker instead of poisoning the row.
    macro_rules! map {
        ($t:ty, $f:expr) => {
            match row.try_get::<_, Option<$t>>(i) {
                Ok(Some(v)) => $f(v),
                Ok(None) => J::Null,
                Err(e) => J::String(format!("<decode error: {e}>")),
            }
        };
    }

    match ty {
        Type::BOOL => map!(bool, J::Bool),
        Type::INT2 => map!(i16, J::from),
        Type::INT4 => map!(i32, J::from),
        Type::INT8 => map!(i64, J::from),
        Type::FLOAT4 => map!(f32, J::from),
        Type::FLOAT8 => map!(f64, J::from),
        Type::NUMERIC => map!(Decimal, |v: Decimal| J::String(v.to_string())),
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME => map!(String, J::String),
        // The internal single-byte "char" type decodes as i8, not a string.
        Type::CHAR => map!(i8, J::from),
        Type::UUID => map!(uuid::Uuid, |v: uuid::Uuid| J::String(v.to_string())),
        Type::JSON | Type::JSONB => map!(J, |v| v),
        Type::TIMESTAMP => {
            map!(chrono::NaiveDateTime, |v: chrono::NaiveDateTime| J::String(v.to_string()))
        }
        Type::TIMESTAMPTZ => {
            map!(chrono::DateTime<chrono::Utc>, |v: chrono::DateTime<chrono::Utc>| {
                J::String(v.to_rfc3339())
            })
        }
        Type::DATE => map!(chrono::NaiveDate, |v: chrono::NaiveDate| J::String(v.to_string())),
        Type::TIME => map!(chrono::NaiveTime, |v: chrono::NaiveTime| J::String(v.to_string())),
        Type::BYTEA => map!(Vec<u8>, |v: Vec<u8>| J::String(format!("\\x{}", hex(&v)))),
        Type::TEXT_ARRAY | Type::VARCHAR_ARRAY => map!(Vec<Option<String>>, text_array),
        Type::INT4_ARRAY => map!(Vec<Option<i32>>, int_array),
        Type::INT8_ARRAY => map!(Vec<Option<i64>>, bigint_array),
        // Fallback: many types have a text representation the driver can hand
        // back; if not, show the type name so the cell is at least labeled.
        other => match row.try_get::<_, Option<String>>(i) {
            Ok(Some(s)) => J::String(s),
            Ok(None) => J::Null,
            Err(_) => J::String(format!("<{}>", other.name())),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dsn() -> String {
        std::env::var("PSQLVIEWER_TEST_DSN")
            .unwrap_or_else(|_| "postgres://heroage:heroage@localhost:5432/heroage".into())
    }

    async fn test_client() -> Client {
        let (client, connection) = tokio_postgres::connect(&test_dsn(), NoTls)
            .await
            .expect("connect");
        tokio::spawn(connection);
        client
    }

    /// Exercises the type mapper against a live Postgres. Requires the local
    /// dev DB (docker: backend-postgres-1) to be up.
    #[tokio::test]
    async fn cell_maps_core_types() {
        let client = test_client().await;

        let rows = client
            .query(
                r#"select
                    true as b,
                    42::int2 as i2, 42::int4 as i4, 42::int8 as i8,
                    1.5::float8 as f8,
                    12345.6789::numeric as num,
                    'hi'::text as t,
                    'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid as u,
                    '{"a": [1, null]}'::jsonb as js,
                    now() as tstz,
                    current_date as d,
                    '\xdeadbeef'::bytea as bin,
                    array['x', null, 'y'] as arr,
                    null::text as nul,
                    '192.168.0.1'::inet as fallback_ty"#,
                &[],
            )
            .await
            .expect("query");
        let row = &rows[0];

        assert_eq!(cell(row, 0), J::Bool(true));
        assert_eq!(cell(row, 1), J::from(42));
        assert_eq!(cell(row, 2), J::from(42));
        assert_eq!(cell(row, 3), J::from(42));
        assert_eq!(cell(row, 4), J::from(1.5));
        assert_eq!(cell(row, 5), J::String("12345.6789".into()));
        assert_eq!(cell(row, 6), J::String("hi".into()));
        assert_eq!(
            cell(row, 7),
            J::String("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11".into())
        );
        assert_eq!(cell(row, 8), serde_json::json!({"a": [1, null]}));
        assert!(matches!(cell(row, 9), J::String(_)), "timestamptz");
        assert!(matches!(cell(row, 10), J::String(_)), "date");
        assert_eq!(cell(row, 11), J::String("\\xdeadbeef".into()));
        assert_eq!(cell(row, 12), serde_json::json!(["x", null, "y"]));
        assert_eq!(cell(row, 13), J::Null);
        // inet has no dedicated arm; must not panic, and should label or decode.
        let fb = cell(row, 14);
        assert!(matches!(fb, J::String(_)), "inet fallback: {fb:?}");
    }

    /// The sidebar query must return public-schema tables from the dev DB and
    /// exclude system schemas.
    #[tokio::test]
    async fn object_listing_query_works() {
        let client = test_client().await;
        let rows = client
            .query(
                r#"select n.nspname, c.relname
                   from pg_class c join pg_namespace n on n.oid = c.relnamespace
                   where c.relkind in ('r', 'p', 'v', 'm', 'f')
                     and n.nspname not in ('pg_catalog', 'information_schema')
                     and n.nspname not like 'pg_toast%'"#,
                &[],
            )
            .await
            .expect("query");
        assert!(!rows.is_empty(), "dev DB should have at least one table");
        assert!(rows.iter().all(|r| {
            let s: String = r.get(0);
            !s.starts_with("pg_")
        }));
    }
}
