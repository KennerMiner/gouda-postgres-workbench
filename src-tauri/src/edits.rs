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
pub struct JsonSet {
    /// Path elements as text (array indices sent as their decimal string).
    path: Vec<String>,
    /// New node as a JSON literal ("\"x\"", "42", "null", "{...}").
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellEdit {
    column: String,
    cast_type: String,
    /// None = SET NULL (when `json_sets` is empty).
    value: Option<String>,
    /// Non-empty = stage node edits as a jsonb_set chain instead of
    /// rewriting the whole document.
    #[serde(default)]
    json_sets: Vec<JsonSet>,
    pk: Vec<PkVal>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowDelete {
    pk: Vec<PkVal>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertCell {
    column: String,
    cast_type: String,
    /// None = explicit NULL (a column absent from `cells` takes its DEFAULT).
    value: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowInsert {
    cells: Vec<InsertCell>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ChangeSet {
    edits: Vec<CellEdit>,
    deletes: Vec<RowDelete>,
    inserts: Vec<RowInsert>,
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

fn where_pk(pk: &[PkVal]) -> Result<String, String> {
    if pk.is_empty() {
        return Err("change without primary key".into());
    }
    let mut wheres = Vec::with_capacity(pk.len());
    for p in pk {
        check_cast(&p.cast_type)?;
        wheres.push(format!(
            "{} = {}::{}",
            qi(&p.column),
            quote_literal(&p.value),
            p.cast_type
        ));
    }
    Ok(wheres.join(" and "))
}

fn build_delete(schema: &str, table: &str, del: &RowDelete) -> Result<String, String> {
    Ok(format!(
        "delete from {}.{} where {}",
        qi(schema),
        qi(table),
        where_pk(&del.pk)?
    ))
}

fn build_insert(schema: &str, table: &str, ins: &RowInsert) -> Result<String, String> {
    if ins.cells.is_empty() {
        return Ok(format!("insert into {}.{} default values", qi(schema), qi(table)));
    }
    let mut cols = Vec::with_capacity(ins.cells.len());
    let mut vals = Vec::with_capacity(ins.cells.len());
    for cell in &ins.cells {
        check_cast(&cell.cast_type)?;
        cols.push(qi(&cell.column));
        vals.push(match &cell.value {
            Some(v) => format!("{}::{}", quote_literal(v), cell.cast_type),
            None => "null".to_string(),
        });
    }
    Ok(format!(
        "insert into {}.{} ({}) values ({})",
        qi(schema),
        qi(table),
        cols.join(", "),
        vals.join(", ")
    ))
}

/// Postgres text[] literal for a jsonb_set path. Every element is
/// double-quoted so keys with commas/braces/quotes survive.
fn pg_text_array(path: &[String]) -> String {
    let elems: Vec<String> = path
        .iter()
        .map(|p| format!("\"{}\"", p.replace('\\', "\\\\").replace('"', "\\\"")))
        .collect();
    format!("{{{}}}", elems.join(","))
}

fn build_json_set_expr(edit: &CellEdit) -> Result<String, String> {
    if edit.value.is_some() {
        return Err("edit has both a whole-cell value and json_sets".into());
    }
    if edit.cast_type != "json" && edit.cast_type != "jsonb" {
        return Err(format!("json_sets on non-json column ({})", edit.cast_type));
    }
    let json_col = edit.cast_type == "json";
    let mut expr = qi(&edit.column);
    if json_col {
        expr = format!("{expr}::jsonb");
    }
    for s in &edit.json_sets {
        if s.path.is_empty() {
            return Err("json_set with empty path".into());
        }
        // Defense in depth: the value must be valid JSON before it goes near SQL.
        serde_json::from_str::<serde_json::Value>(&s.value)
            .map_err(|e| format!("json_set value is not valid JSON: {e}"))?;
        expr = format!(
            "jsonb_set({expr}, {}, {}::jsonb)",
            quote_literal(&pg_text_array(&s.path)),
            quote_literal(&s.value)
        );
    }
    if json_col {
        expr = format!("({expr})::json");
    }
    Ok(expr)
}

fn build_statement(schema: &str, table: &str, edit: &CellEdit) -> Result<String, String> {
    check_cast(&edit.cast_type)?;
    let set = if !edit.json_sets.is_empty() {
        format!("{} = {}", qi(&edit.column), build_json_set_expr(edit)?)
    } else {
        match &edit.value {
            Some(v) => format!(
                "{} = {}::{}",
                qi(&edit.column),
                quote_literal(v),
                edit.cast_type
            ),
            None => format!("{} = null", qi(&edit.column)),
        }
    };
    Ok(format!(
        "update {}.{} set {} where {}",
        qi(schema),
        qi(table),
        set,
        where_pk(&edit.pk)?
    ))
}

/// Order matters: updates, then deletes, then inserts — so a delete+reinsert
/// of a row with a unique key works within one batch.
fn build_all(schema: &str, table: &str, changes: &ChangeSet) -> Result<Vec<String>, String> {
    let mut statements = Vec::new();
    for e in &changes.edits {
        statements.push(build_statement(schema, table, e)?);
    }
    for d in &changes.deletes {
        statements.push(build_delete(schema, table, d)?);
    }
    for i in &changes.inserts {
        statements.push(build_insert(schema, table, i)?);
    }
    Ok(statements)
}

#[tauri::command]
pub async fn apply_changes(
    state: State<'_, Connections>,
    store: State<'_, Store>,
    conn_id: u32,
    tab_id: u32,
    schema: String,
    table: String,
    changes: ChangeSet,
    dry_run: bool,
) -> Result<Vec<String>, String> {
    let statements = build_all(&schema, &table, &changes)?;
    if statements.is_empty() {
        return Ok(vec![]);
    }

    if dry_run {
        return Ok(statements);
    }

    let entry = state.entry(conn_id).await?;
    // The tab's own session — so applies participate in that tab's
    // transaction when one is open.
    let session = entry.session(tab_id).await?;
    let client = &*session;
    let started_at = chrono::Utc::now().timestamp_millis();
    let start = std::time::Instant::now();

    client
        .batch_execute("begin")
        .await
        .map_err(|e| format!("begin: {}", crate::db::pg_err(&e)))?;

    for stmt in &statements {
        let n = match client.execute(stmt.as_str(), &[]).await {
            Ok(n) => n,
            Err(e) => {
                let _ = client.batch_execute("rollback").await;
                return Err(format!(
                    "{}\n\nin: {stmt}\n\nrolled back — nothing applied",
                    crate::db::pg_err(&e)
                ));
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
        .map_err(|e| format!("commit: {}", crate::db::pg_err(&e)))?;

    crate::history::record(
        &store,
        entry.label(),
        &format!("-- applied {} change(s)\n{}", statements.len(), statements.join(";\n")),
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
            json_sets: vec![],
            pk: vec![PkVal {
                column: "id".into(),
                cast_type: "int4".into(),
                value: "7".into(),
            }],
        }
    }

    fn jset(path: &[&str], value: &str) -> JsonSet {
        JsonSet {
            path: path.iter().map(|s| s.to_string()).collect(),
            value: value.into(),
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

    #[test]
    fn json_set_single_node() {
        let mut e = edit("payload", "jsonb", None);
        e.json_sets = vec![jset(&["rolledStats", "0", "statId"], r#""critBuff""#)];
        let sql = build_statement("public", "player_items", &e).unwrap();
        assert_eq!(
            sql,
            r#"update "public"."player_items" set "payload" = jsonb_set("payload", '{"rolledStats","0","statId"}', '"critBuff"'::jsonb) where "id" = '7'::int4"#
        );
    }

    #[test]
    fn json_set_chains_in_order() {
        let mut e = edit("payload", "jsonb", None);
        e.json_sets = vec![jset(&["grade"], "2"), jset(&["starLevel"], "3")];
        let sql = build_statement("s", "t", &e).unwrap();
        assert!(sql.contains(
            r#"jsonb_set(jsonb_set("payload", '{"grade"}', '2'::jsonb), '{"starLevel"}', '3'::jsonb)"#
        ));
    }

    #[test]
    fn json_set_wraps_plain_json_column() {
        let mut e = edit("cfg", "json", None);
        e.json_sets = vec![jset(&["a"], "true")];
        let sql = build_statement("s", "t", &e).unwrap();
        assert!(sql.contains(r#""cfg" = (jsonb_set("cfg"::jsonb, '{"a"}', 'true'::jsonb))::json"#));
    }

    #[test]
    fn json_set_escapes_path_elements() {
        let mut e = edit("payload", "jsonb", None);
        e.json_sets = vec![jset(&[r#"we"ird, key"#], "1")];
        let sql = build_statement("s", "t", &e).unwrap();
        assert!(sql.contains(r#"'{"we\"ird, key"}'"#));
    }

    #[test]
    fn json_set_rejects_bad_input() {
        // invalid JSON value
        let mut e = edit("payload", "jsonb", None);
        e.json_sets = vec![jset(&["a"], "{oops")];
        assert!(build_statement("s", "t", &e).is_err());
        // non-json column
        let mut e = edit("name", "text", None);
        e.json_sets = vec![jset(&["a"], "1")];
        assert!(build_statement("s", "t", &e).is_err());
        // both whole-value and sets
        let mut e = edit("payload", "jsonb", Some("{}"));
        e.json_sets = vec![jset(&["a"], "1")];
        assert!(build_statement("s", "t", &e).is_err());
        // empty path
        let mut e = edit("payload", "jsonb", None);
        e.json_sets = vec![jset(&[], "1")];
        assert!(build_statement("s", "t", &e).is_err());
    }

    #[test]
    fn generates_delete() {
        let d = RowDelete {
            pk: vec![PkVal {
                column: "id".into(),
                cast_type: "int8".into(),
                value: "9".into(),
            }],
        };
        assert_eq!(
            build_delete("public", "items", &d).unwrap(),
            r#"delete from "public"."items" where "id" = '9'::int8"#
        );
        assert!(build_delete("public", "items", &RowDelete { pk: vec![] }).is_err());
    }

    #[test]
    fn generates_insert() {
        let ins = RowInsert {
            cells: vec![
                InsertCell {
                    column: "name".into(),
                    cast_type: "text".into(),
                    value: Some("O'Neil".into()),
                },
                InsertCell {
                    column: "payload".into(),
                    cast_type: "jsonb".into(),
                    value: None,
                },
            ],
        };
        assert_eq!(
            build_insert("public", "items", &ins).unwrap(),
            r#"insert into "public"."items" ("name", "payload") values ('O''Neil'::text, null)"#
        );
        assert_eq!(
            build_insert("public", "items", &RowInsert { cells: vec![] }).unwrap(),
            r#"insert into "public"."items" default values"#
        );
    }

    #[test]
    fn change_ordering_updates_deletes_inserts() {
        let changes = ChangeSet {
            edits: vec![edit("c", "text", Some("v"))],
            deletes: vec![RowDelete {
                pk: vec![PkVal {
                    column: "id".into(),
                    cast_type: "int4".into(),
                    value: "1".into(),
                }],
            }],
            inserts: vec![RowInsert { cells: vec![] }],
        };
        let stmts = build_all("s", "t", &changes).unwrap();
        assert!(stmts[0].starts_with("update"));
        assert!(stmts[1].starts_with("delete"));
        assert!(stmts[2].starts_with("insert"));
    }
}
