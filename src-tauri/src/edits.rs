//! Applying staged grid edits as UPDATE statements.
//!
//! The frontend stages cell changes and sends them here. `dry_run: true`
//! returns the exact SQL that would run (shown in the preview dialog);
//! `dry_run: false` executes inside a transaction where every UPDATE must
//! affect exactly one row, or the whole batch rolls back.

use serde::Deserialize;
use tauri::State;

use crate::db::Connections;
use crate::store::Store;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PkVal {
    column: String,
    cast_type: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellEdit {
    column: String,
    cast_type: String,
    /// None = SET NULL.
    value: Option<String>,
    pk: Vec<PkVal>,
}

fn qi(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn quote_literal(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}

/// Cast types come from the server's own type names, but validate anyway —
/// they end up in SQL text.
fn check_cast(t: &str) -> Result<(), String> {
    if !t.is_empty()
        && t.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == ' ')
        && !t.starts_with('_')
    {
        Ok(())
    } else {
        Err(format!("unsupported cast type: {t}"))
    }
}

fn build_statement(schema: &str, table: &str, edit: &CellEdit) -> Result<String, String> {
    check_cast(&edit.cast_type)?;
    let set = match &edit.value {
        Some(v) => format!(
            "{} = {}::{}",
            qi(&edit.column),
            quote_literal(v),
            edit.cast_type
        ),
        None => format!("{} = null", qi(&edit.column)),
    };
    let mut wheres = Vec::with_capacity(edit.pk.len());
    for pk in &edit.pk {
        check_cast(&pk.cast_type)?;
        wheres.push(format!(
            "{} = {}::{}",
            qi(&pk.column),
            quote_literal(&pk.value),
            pk.cast_type
        ));
    }
    if wheres.is_empty() {
        return Err("edit without primary key".into());
    }
    Ok(format!(
        "update {}.{} set {} where {}",
        qi(schema),
        qi(table),
        set,
        wheres.join(" and ")
    ))
}

#[tauri::command]
pub async fn apply_edits(
    state: State<'_, Connections>,
    store: State<'_, Store>,
    conn_id: u32,
    schema: String,
    table: String,
    edits: Vec<CellEdit>,
    dry_run: bool,
) -> Result<Vec<String>, String> {
    if edits.is_empty() {
        return Ok(vec![]);
    }
    let statements = edits
        .iter()
        .map(|e| build_statement(&schema, &table, e))
        .collect::<Result<Vec<_>, _>>()?;

    if dry_run {
        return Ok(statements);
    }

    let entry = state.entry(conn_id).await?;
    let client = entry.client();
    let started_at = chrono::Utc::now().timestamp_millis();
    let start = std::time::Instant::now();

    client
        .batch_execute("begin")
        .await
        .map_err(|e| format!("begin: {e}"))?;

    for stmt in &statements {
        let n = match client.execute(stmt.as_str(), &[]).await {
            Ok(n) => n,
            Err(e) => {
                let _ = client.batch_execute("rollback").await;
                return Err(format!("{e}\n\nin: {stmt}\n\nrolled back — nothing applied"));
            }
        };
        if n != 1 {
            let _ = client.batch_execute("rollback").await;
            return Err(format!(
                "{stmt}\n\nmatched {n} rows (expected exactly 1) — rolled back, nothing applied"
            ));
        }
    }

    client
        .batch_execute("commit")
        .await
        .map_err(|e| format!("commit: {e}"))?;

    crate::history::record(
        &store,
        entry.label(),
        &format!("-- applied {} edit(s)\n{}", statements.len(), statements.join(";\n")),
        started_at,
        Some(start.elapsed().as_millis() as i64),
        Some(statements.len() as i64),
        None,
    );
    Ok(statements)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(column: &str, cast: &str, value: Option<&str>) -> CellEdit {
        CellEdit {
            column: column.into(),
            cast_type: cast.into(),
            value: value.map(String::from),
            pk: vec![PkVal {
                column: "id".into(),
                cast_type: "int4".into(),
                value: "7".into(),
            }],
        }
    }

    #[test]
    fn generates_update() {
        let sql = build_statement("public", "heroes", &edit("name", "text", Some("Ragnar"))).unwrap();
        assert_eq!(
            sql,
            r#"update "public"."heroes" set "name" = 'Ragnar'::text where "id" = '7'::int4"#
        );
    }

    #[test]
    fn null_sets_null() {
        let sql = build_statement("public", "heroes", &edit("name", "text", None)).unwrap();
        assert!(sql.contains(r#""name" = null"#));
    }

    #[test]
    fn escapes_quotes_in_values_and_idents() {
        let sql = build_statement(
            "public",
            r#"we"ird"#,
            &edit(r#"na"me"#, "text", Some("it's; drop table x; --")),
        )
        .unwrap();
        assert!(sql.contains(r#""we""ird""#));
        assert!(sql.contains(r#""na""me""#));
        assert!(sql.contains("'it''s; drop table x; --'"));
    }

    #[test]
    fn rejects_bad_cast_types() {
        assert!(build_statement("s", "t", &edit("c", "text; drop table x", Some("v"))).is_err());
        assert!(build_statement("s", "t", &edit("c", "_text", Some("v"))).is_err());
        assert!(build_statement("s", "t", &edit("c", "TEXT", Some("v"))).is_err());
    }

    #[test]
    fn rejects_missing_pk() {
        let mut e = edit("c", "text", Some("v"));
        e.pk.clear();
        assert!(build_statement("s", "t", &e).is_err());
    }
}
