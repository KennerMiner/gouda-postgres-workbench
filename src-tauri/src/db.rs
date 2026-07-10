//! M0 vertical spike: connect to Postgres, run one query, map core types to
//! JSON, and stream rows to the frontend over a Tauri Channel.
//!
//! Deliberately thin. No pooling, no TLS, no SSH, no cancel yet — those land in
//! M1. The point here is to prove the type-mapping + Channel boundary works
//! before we build anything on top of it.

use futures::{pin_mut, StreamExt};
use postgres_types::Type;
use rust_decimal::Decimal;
use serde::Serialize;
use serde_json::Value as J;
use tauri::ipc::Channel;
use tokio_postgres::{types::ToSql, NoTls, Row};

/// Rows are flushed to the UI in batches of this size so a large result set
/// streams in rather than materializing entirely before the first paint.
const BATCH: usize = 500;

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

/// Run a single SQL statement and stream results to `on_event`.
///
/// Uses the extended protocol (prepare + query_raw), so exactly one statement
/// is supported — multi-statement scripts and utility statements that can't be
/// prepared are an M1 concern.
#[tauri::command]
pub async fn run_query(dsn: String, sql: String, on_event: Channel<QueryEvent>) -> Result<(), String> {
    let start = std::time::Instant::now();

    let (client, connection) = match tokio_postgres::connect(&dsn, NoTls).await {
        Ok(pair) => pair,
        Err(e) => {
            let _ = on_event.send(QueryEvent::Error { message: format!("connect: {e}") });
            return Ok(());
        }
    };

    // The connection object drives the socket; it must be polled on its own task
    // for the client handle to make progress.
    let conn_handle = tokio::spawn(async move {
        if let Err(e) = connection.await {
            eprintln!("postgres connection error: {e}");
        }
    });

    let result: Result<(), String> = async {
        let stmt = client.prepare(&sql).await.map_err(|e| format!("prepare: {e}"))?;

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
            .map_err(|e| format!("query: {e}"))?;
        pin_mut!(stream);

        let mut batch: Vec<Vec<J>> = Vec::with_capacity(BATCH);
        let mut total = 0usize;
        while let Some(item) = stream.next().await {
            let row = item.map_err(|e| format!("row: {e}"))?;
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
    }

    drop(client);
    let _ = conn_handle.await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Exercises the type mapper against a live Postgres. Requires the local
    /// dev DB (docker: backend-postgres-1) to be up.
    #[tokio::test]
    async fn cell_maps_core_types() {
        let dsn = std::env::var("PSQLVIEWER_TEST_DSN")
            .unwrap_or_else(|_| "postgres://heroage:heroage@localhost:5432/heroage".into());
        let (client, connection) = tokio_postgres::connect(&dsn, NoTls).await.expect("connect");
        tokio::spawn(connection);

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
        assert_eq!(
            cell(row, 12),
            serde_json::json!(["x", null, "y"])
        );
        assert_eq!(cell(row, 13), J::Null);
        // inet has no dedicated arm; must not panic, and should label or decode.
        let fb = cell(row, 14);
        assert!(matches!(fb, J::String(_)), "inet fallback: {fb:?}");
    }
}
