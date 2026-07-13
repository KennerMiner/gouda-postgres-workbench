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

/// Default cap on rows delivered to the UI — a guard against `select *` on a
/// 10M-row table eating all memory. The frontend flags truncation.
const MAX_ROWS_DEFAULT: usize = 50_000;

/// A connection: a base client for metadata plus lazily-created per-tab
/// sessions (queries in different tabs run concurrently; transactions are
/// per-tab). Sessions share the stored config — and therefore the SSH tunnel,
/// whose local listener accepts any number of TCP connections.
pub struct ConnEntry {
    config: tokio_postgres::Config,
    base: Client,
    label: String,
    read_only: std::sync::atomic::AtomicBool,
    sessions: Mutex<HashMap<u32, Arc<Client>>>,
    _tunnel: Option<crate::tunnel::Tunnel>,
}

#[derive(Default)]
pub struct Connections {
    next_id: AtomicU32,
    map: Mutex<HashMap<u32, Arc<ConnEntry>>>,
}

impl ConnEntry {
    /// The base client — metadata queries (catalog, structure, sidebar).
    pub(crate) fn client(&self) -> &Client {
        &self.base
    }

    pub(crate) fn label(&self) -> &str {
        &self.label
    }

    async fn spawn_session(&self) -> Result<Client, String> {
        let (client, connection) = self
            .config
            .connect(NoTls)
            .await
            .map_err(|e| format!("session connect: {}", pg_err(&e)))?;
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                eprintln!("postgres session error: {e}");
            }
        });
        if self.read_only.load(std::sync::atomic::Ordering::Relaxed) {
            client
                .batch_execute("set default_transaction_read_only = on")
                .await
                .map_err(|e| format!("read-only setup: {}", pg_err(&e)))?;
        }
        Ok(client)
    }

    /// The session for a tab, created on first use; dead sessions respawn
    /// transparently (e.g. after laptop sleep).
    pub(crate) async fn session(&self, tab_id: u32) -> Result<Arc<Client>, String> {
        let mut map = self.sessions.lock().await;
        if let Some(c) = map.get(&tab_id) {
            if !c.is_closed() {
                return Ok(c.clone());
            }
            map.remove(&tab_id);
        }
        let client = Arc::new(self.spawn_session().await?);
        map.insert(tab_id, client.clone());
        Ok(client)
    }

    pub(crate) async fn drop_session(&self, tab_id: u32) {
        self.sessions.lock().await.remove(&tab_id);
    }

    pub(crate) async fn set_read_only(&self, on: bool) -> Result<(), String> {
        self.read_only
            .store(on, std::sync::atomic::Ordering::Relaxed);
        let sql = if on {
            "set default_transaction_read_only = on"
        } else {
            "set default_transaction_read_only = off"
        };
        self.base
            .batch_execute(sql)
            .await
            .map_err(|e| pg_err(&e))?;
        for c in self.sessions.lock().await.values() {
            let _ = c.batch_execute(sql).await;
        }
        Ok(())
    }
}

impl Connections {
    /// Public lookup for other modules (edits, …).
    pub(crate) async fn entry(&self, id: u32) -> Result<Arc<ConnEntry>, String> {
        self.get(id).await
    }

    async fn get(&self, id: u32) -> Result<Arc<ConnEntry>, String> {
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

/// Human-usable Postgres error: unwrap the DbError (message/detail/hint)
/// instead of tokio-postgres's terse category Display ("db error").
pub(crate) fn pg_err(e: &tokio_postgres::Error) -> String {
    if let Some(db) = e.as_db_error() {
        let mut s = format!("{}: {}", db.severity(), db.message());
        if let Some(d) = db.detail() {
            s.push_str(&format!("\n{d}"));
        }
        if let Some(h) = db.hint() {
            s.push_str(&format!("\nhint: {h}"));
        }
        s
    } else {
        let mut s = e.to_string();
        let mut src = std::error::Error::source(e);
        while let Some(inner) = src {
            s.push_str(&format!(": {inner}"));
            src = std::error::Error::source(inner);
        }
        s
    }
}

fn host_of(config: &tokio_postgres::Config) -> String {
    config
        .get_hosts()
        .first()
        .map(|h| match h {
            tokio_postgres::config::Host::Tcp(s) => s.clone(),
            tokio_postgres::config::Host::Unix(p) => p.display().to_string(),
        })
        .unwrap_or_else(|| "?".into())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnInfo {
    pub conn_id: u32,
    pub server_version: String,
    pub user: String,
    pub database: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    name: String,
    type_name: String,
    type_oid: u32,
}

/// Present when the result set is safely editable: every column comes from one
/// table and that table's full primary key appears in the result.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EditableInfo {
    schema: String,
    table: String,
    /// Indices (into the result columns) of the primary-key columns.
    pk_indices: Vec<usize>,
    /// Per result column: does it belong to the table (i.e. can be SET)?
    /// Array types are excluded for now (text-cast round-trip is unreliable).
    editable_cols: Vec<bool>,
}

async fn detect_editable(
    client: &Client,
    stmt: &tokio_postgres::Statement,
) -> Option<EditableInfo> {
    let cols = stmt.columns();
    if cols.is_empty() {
        return None;
    }

    // All real columns must come from the same table.
    let mut table_oid: Option<u32> = None;
    for c in cols {
        if let Some(oid) = c.table_oid() {
            if *table_oid.get_or_insert(oid) != oid {
                return None; // join across tables
            }
        }
    }
    let table_oid = table_oid?;

    let row = client
        .query_one(
            r#"select n.nspname,
                      c.relname,
                      (select array_agg(k.attnum)
                       from pg_index i, unnest(i.indkey) k(attnum)
                       where i.indrelid = c.oid and i.indisprimary)
               from pg_class c
               join pg_namespace n on n.oid = c.relnamespace
               where c.oid = $1"#,
            &[&table_oid],
        )
        .await
        .ok()?;
    let schema: String = row.get(0);
    let table: String = row.get(1);
    let pk_attnums: Option<Vec<i16>> = row.get(2);
    let pk_attnums = pk_attnums?; // no primary key -> read-only

    // Every PK column must be present in the result set.
    let mut pk_indices = Vec::with_capacity(pk_attnums.len());
    for attnum in &pk_attnums {
        let idx = cols.iter().position(|c| {
            c.table_oid() == Some(table_oid) && c.column_id() == Some(*attnum)
        })?;
        pk_indices.push(idx);
    }

    let editable_cols = cols
        .iter()
        .map(|c| {
            c.table_oid() == Some(table_oid)
                && c.column_id().is_some_and(|id| id > 0)
                && !c.type_().name().starts_with('_')
        })
        .collect();

    Some(EditableInfo {
        schema,
        table,
        pk_indices,
        editable_cols,
    })
}

/// Streaming protocol sent over the Channel. One `Meta`, then zero or more
/// `Rows`, terminated by exactly one `Done` or one `Error`.
///
/// NB: `rename_all` renames the variant tag only; `rename_all_fields` is what
/// camel-cases the fields inside variants (row_count -> rowCount).
#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum QueryEvent {
    Meta {
        columns: Vec<ColumnMeta>,
        editable: Option<EditableInfo>,
    },
    Rows { rows: Vec<Vec<J>> },
    Done { row_count: usize, elapsed_ms: u64, truncated: bool },
    Error { message: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbObject {
    schema: String,
    name: String,
    kind: String,
}

/// Open a connection from a prepared Config, run the identity handshake, and
/// register it. Shared by ad-hoc DSN connect and profile connect.
pub async fn open_config(
    state: &Connections,
    mut config: tokio_postgres::Config,
    tunnel: Option<crate::tunnel::Tunnel>,
) -> Result<ConnInfo, String> {
    if config.get_connect_timeout().is_none() {
        config.connect_timeout(std::time::Duration::from_secs(10));
    }
    let (client, connection) = config
        .connect(NoTls)
        .await
        .map_err(|e| format!("connect: {}", pg_err(&e)))?;

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
        .map_err(|e| format!("handshake: {}", pg_err(&e)))?;

    let server_version: String = row.get(0);
    let user: String = row.get(1);
    let database: String = row.get(2);

    let conn_id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let label = format!("{user}@{}/{database}", host_of(&config));
    state.map.lock().await.insert(
        conn_id,
        Arc::new(ConnEntry {
            config,
            base: client,
            label,
            read_only: std::sync::atomic::AtomicBool::new(false),
            sessions: Mutex::new(HashMap::new()),
            _tunnel: tunnel,
        }),
    );

    Ok(ConnInfo {
        conn_id,
        server_version,
        user,
        database,
    })
}

#[tauri::command]
pub async fn connect(state: State<'_, Connections>, dsn: String) -> Result<ConnInfo, String> {
    let config = dsn
        .parse::<tokio_postgres::Config>()
        .map_err(|e| format!("dsn: {e}"))?;
    open_config(&state, config, None).await
}

/// Cancel whatever is currently running on this connection. Postgres cancel
/// goes out-of-band on a fresh socket, so this works while `run_query` is
/// blocked streaming.
#[tauri::command]
pub async fn cancel_query(
    state: State<'_, Connections>,
    conn_id: u32,
    tab_id: u32,
) -> Result<(), String> {
    let entry = state.get(conn_id).await?;
    let token = match entry.sessions.lock().await.get(&tab_id) {
        Some(c) => c.cancel_token(),
        None => entry.base.cancel_token(),
    };
    token
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
    let entry = state.get(conn_id).await?;
    let rows = entry
        .client()
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
                 and n.nspname <> 'information_schema'
                 and n.nspname !~ '^pg_'  -- catalog, toast, temp schemas
               order by 1, 3, 2"#,
            &[],
        )
        .await
        .map_err(|e| format!("list objects: {}", pg_err(&e)));
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
            state.drop_if_closed(conn_id, &entry.client()).await;
            Err(e)
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogColumn {
    name: String,
    data_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogTable {
    schema: String,
    name: String,
    columns: Vec<CatalogColumn>,
}

/// Tables/views with their columns and formatted types — the autocomplete
/// dictionary. One round trip; rows arrive grouped by table.
#[tauri::command]
pub async fn schema_catalog(
    state: State<'_, Connections>,
    conn_id: u32,
) -> Result<Vec<CatalogTable>, String> {
    let entry = state.get(conn_id).await?;
    let rows = entry
        .client()
        .query(
            r#"select n.nspname,
                      c.relname,
                      a.attname,
                      format_type(a.atttypid, a.atttypmod)
               from pg_class c
               join pg_namespace n on n.oid = c.relnamespace
               join pg_attribute a on a.attrelid = c.oid
               where c.relkind in ('r', 'p', 'v', 'm', 'f')
                 and n.nspname <> 'information_schema'
                 and n.nspname !~ '^pg_'
                 and a.attnum > 0
                 and not a.attisdropped
               order by n.nspname, c.relname, a.attnum"#,
            &[],
        )
        .await
        .map_err(|e| {
            let msg = format!("catalog: {}", pg_err(&e));
            msg
        });
    let rows = match rows {
        Ok(r) => r,
        Err(e) => {
            state.drop_if_closed(conn_id, &entry.client()).await;
            return Err(e);
        }
    };

    let mut tables: Vec<CatalogTable> = Vec::new();
    for row in rows {
        let schema: String = row.get(0);
        let name: String = row.get(1);
        let col = CatalogColumn {
            name: row.get(2),
            data_type: row.get(3),
        };
        match tables.last_mut() {
            Some(t) if t.schema == schema && t.name == name => t.columns.push(col),
            _ => tables.push(CatalogTable {
                schema,
                name,
                columns: vec![col],
            }),
        }
    }
    Ok(tables)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructColumn {
    name: String,
    data_type: String,
    nullable: bool,
    default_expr: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructIndex {
    name: String,
    definition: String,
    primary: bool,
    unique: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructConstraint {
    name: String,
    kind: String,
    definition: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableStructure {
    columns: Vec<StructColumn>,
    indexes: Vec<StructIndex>,
    constraints: Vec<StructConstraint>,
}

/// Structure tab data: columns with defaults, indexes, constraints.
#[tauri::command]
pub async fn table_structure(
    state: State<'_, Connections>,
    conn_id: u32,
    schema: String,
    table: String,
) -> Result<TableStructure, String> {
    let entry = state.get(conn_id).await?;
    let client = entry.client();
    let run = async {
        let cols = client
            .query(
                r#"select a.attname,
                          format_type(a.atttypid, a.atttypmod),
                          not a.attnotnull,
                          pg_get_expr(d.adbin, d.adrelid)
                   from pg_attribute a
                   left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
                   where a.attrelid = to_regclass(quote_ident($1) || '.' || quote_ident($2))
                     and a.attnum > 0 and not a.attisdropped
                   order by a.attnum"#,
                &[&schema, &table],
            )
            .await
            .map_err(|e| pg_err(&e))?;
        let indexes = client
            .query(
                r#"select ci.relname, pg_get_indexdef(i.indexrelid), i.indisprimary, i.indisunique
                   from pg_index i join pg_class ci on ci.oid = i.indexrelid
                   where i.indrelid = to_regclass(quote_ident($1) || '.' || quote_ident($2))
                   order by i.indisprimary desc, ci.relname"#,
                &[&schema, &table],
            )
            .await
            .map_err(|e| pg_err(&e))?;
        let cons = client
            .query(
                r#"select conname, contype::text, pg_get_constraintdef(oid)
                   from pg_constraint
                   where conrelid = to_regclass(quote_ident($1) || '.' || quote_ident($2))
                   order by contype, conname"#,
                &[&schema, &table],
            )
            .await
            .map_err(|e| pg_err(&e))?;
        Ok(TableStructure {
            columns: cols
                .iter()
                .map(|r| StructColumn {
                    name: r.get(0),
                    data_type: r.get(1),
                    nullable: r.get(2),
                    default_expr: r.get(3),
                })
                .collect(),
            indexes: indexes
                .iter()
                .map(|r| StructIndex {
                    name: r.get(0),
                    definition: r.get(1),
                    primary: r.get(2),
                    unique: r.get(3),
                })
                .collect(),
            constraints: cons
                .iter()
                .map(|r| StructConstraint {
                    name: r.get(0),
                    kind: match r.get::<_, String>(1).as_str() {
                        "p" => "primary key".into(),
                        "f" => "foreign key".into(),
                        "u" => "unique".into(),
                        "c" => "check".into(),
                        "x" => "exclusion".into(),
                        other => other.to_string(),
                    },
                    definition: r.get(2),
                })
                .collect(),
        })
    };
    let result: Result<TableStructure, String> = run.await;
    if result.is_err() {
        state.drop_if_closed(conn_id, client).await;
    }
    result
}

/// Fire-and-forget statement on a TAB's session — transaction control
/// (begin/commit/rollback) is per-tab by design.
#[tauri::command]
pub async fn exec_session(
    state: State<'_, Connections>,
    conn_id: u32,
    tab_id: u32,
    sql: String,
) -> Result<(), String> {
    let entry = state.get(conn_id).await?;
    let client = entry.session(tab_id).await?;
    let res = client.batch_execute(&sql).await.map_err(|e| pg_err(&e));
    if res.is_err() && client.is_closed() {
        entry.drop_session(tab_id).await;
    }
    res
}

/// Session read-only toggle, applied to the base client and every tab session.
#[tauri::command]
pub async fn set_read_only(
    state: State<'_, Connections>,
    conn_id: u32,
    on: bool,
) -> Result<(), String> {
    state.get(conn_id).await?.set_read_only(on).await
}

/// Free a tab's session when the tab closes.
#[tauri::command]
pub async fn close_session(
    state: State<'_, Connections>,
    conn_id: u32,
    tab_id: u32,
) -> Result<(), String> {
    if let Ok(entry) = state.get(conn_id).await {
        entry.drop_session(tab_id).await;
    }
    Ok(())
}

/// EXPLAIN a statement, returning the JSON plan. ANALYZE (which executes the
/// statement!) is only honored for select/with/values queries — a write is
/// always planned without running.
#[tauri::command]
pub async fn explain_query(
    state: State<'_, Connections>,
    history: State<'_, crate::store::Store>,
    conn_id: u32,
    tab_id: u32,
    sql: String,
    analyze: bool,
) -> Result<serde_json::Value, String> {
    let entry = state.get(conn_id).await?;
    let session = entry.session(tab_id).await?;
    let head = sql.trim_start().to_lowercase();
    let safe_analyze =
        analyze && (head.starts_with("select") || head.starts_with("with") || head.starts_with("values"));
    let prefix = if safe_analyze {
        "explain (analyze, buffers, timing, format json) "
    } else {
        "explain (format json) "
    };
    let full = format!("{prefix}{sql}");
    let started_at = chrono::Utc::now().timestamp_millis();
    let start = std::time::Instant::now();

    let row = session.query_one(&full, &[]).await.map_err(|e| pg_err(&e));
    match row {
        Ok(row) => {
            let plan: serde_json::Value = row.get(0);
            crate::history::record(
                &history,
                &entry.label,
                &full,
                started_at,
                Some(start.elapsed().as_millis() as i64),
                None,
                None,
            );
            Ok(plan)
        }
        Err(e) => {
            if session.is_closed() {
                entry.drop_session(tab_id).await;
            }
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
    history: State<'_, crate::store::Store>,
    conn_id: u32,
    tab_id: u32,
    sql: String,
    max_rows: Option<u32>,
    on_event: Channel<QueryEvent>,
) -> Result<(), String> {
    let start = std::time::Instant::now();
    let started_at = chrono::Utc::now().timestamp_millis();
    let entry = match state.get(conn_id).await {
        Ok(c) => c,
        Err(message) => {
            let _ = on_event.send(QueryEvent::Error { message });
            return Ok(());
        }
    };
    let session = match entry.session(tab_id).await {
        Ok(c) => c,
        Err(message) => {
            let _ = on_event.send(QueryEvent::Error { message });
            return Ok(());
        }
    };
    let client: &Client = &session;

    let result: Result<(usize, bool), String> = async {
        let stmt = client.prepare(&sql).await.map_err(|e| pg_err(&e))?;

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
        let editable = detect_editable(client, &stmt).await;
        on_event
            .send(QueryEvent::Meta { columns, editable })
            .map_err(|e| e.to_string())?;

        let params = std::iter::empty::<&(dyn ToSql + Sync)>();
        let stream = client
            .query_raw(&stmt, params)
            .await
            .map_err(|e| pg_err(&e))?;
        pin_mut!(stream);

        let cap = max_rows.map(|n| n as usize).unwrap_or(MAX_ROWS_DEFAULT);
        let mut batch: Vec<Vec<J>> = Vec::with_capacity(BATCH);
        let mut total = 0usize;
        let mut truncated = false;
        while let Some(item) = stream.next().await {
            let row = item.map_err(|e| pg_err(&e))?;
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
            if total >= cap {
                truncated = true;
                // Stop the server-side work too; the connection survives a
                // cancel and drains quickly.
                let token = client.cancel_token();
                tokio::spawn(async move {
                    let _ = token.cancel_query(NoTls).await;
                });
                break;
            }
        }
        if !batch.is_empty() {
            on_event
                .send(QueryEvent::Rows { rows: batch })
                .map_err(|e| e.to_string())?;
        }
        Ok((total, truncated))
    }
    .await;

    let elapsed = start.elapsed().as_millis() as i64;
    match result {
        Ok((total, truncated)) => {
            // Record BEFORE emitting Done: the frontend refreshes its history
            // list on Done, so the row must already be committed.
            crate::history::record(
                &history,
                &entry.label,
                &sql,
                started_at,
                Some(elapsed),
                Some(total as i64),
                None,
            );
            let _ = on_event.send(QueryEvent::Done {
                row_count: total,
                elapsed_ms: elapsed as u64,
                truncated,
            });
        }
        Err(message) => {
            crate::history::record(
                &history,
                &entry.label,
                &sql,
                started_at,
                Some(elapsed),
                None,
                Some(&message),
            );
            let _ = on_event.send(QueryEvent::Error { message });
            if client.is_closed() {
                entry.drop_session(tab_id).await;
            }
            state.drop_if_closed(conn_id, &entry.base).await;
        }
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

    /// Editability detection: single table + full PK present = editable;
    /// computed columns excluded; missing PK or joins = read-only.
    #[tokio::test]
    async fn editable_detection() {
        let client = test_client().await;
        client
            .batch_execute(
                "create temp table edit_t(id int primary key, v text, n numeric);
                 create temp table nopk_t(v text);",
            )
            .await
            .unwrap();

        let stmt = client.prepare("select id, v, n from edit_t").await.unwrap();
        let info = detect_editable(&client, &stmt).await.expect("editable");
        assert_eq!(info.table, "edit_t");
        assert_eq!(info.pk_indices, vec![0]);
        assert_eq!(info.editable_cols, vec![true, true, true]);

        // Computed column: not SET-able, rest still editable.
        let stmt = client
            .prepare("select id, v || 'x' as vx from edit_t")
            .await
            .unwrap();
        let info = detect_editable(&client, &stmt).await.expect("editable");
        assert_eq!(info.editable_cols, vec![true, false]);

        // PK missing from result -> read-only.
        let stmt = client.prepare("select v from edit_t").await.unwrap();
        assert!(detect_editable(&client, &stmt).await.is_none());

        // Join across tables -> read-only.
        let stmt = client
            .prepare("select a.id, b.v from edit_t a join nopk_t b on true")
            .await
            .unwrap();
        assert!(detect_editable(&client, &stmt).await.is_none());

        // Table without a PK -> read-only.
        let stmt = client.prepare("select v from nopk_t").await.unwrap();
        assert!(detect_editable(&client, &stmt).await.is_none());
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
                     and n.nspname <> 'information_schema'
                     and n.nspname !~ '^pg_'"#,
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
