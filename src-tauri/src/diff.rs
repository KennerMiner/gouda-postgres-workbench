//! Schema diff between two saved profiles: ephemeral connections, one
//! snapshot each, pure comparison.

use std::collections::BTreeMap;

use serde::Serialize;
use tauri::State;
use tokio_postgres::Client;

use crate::store::Store;

#[derive(Clone, PartialEq)]
struct ColSnap {
    data_type: String,
    nullable: bool,
    default_expr: Option<String>,
}

#[derive(Default)]
struct TableSnap {
    columns: BTreeMap<String, ColSnap>,
    indexes: BTreeMap<String, String>,
    constraints: BTreeMap<String, String>,
}

type Snapshot = BTreeMap<String, TableSnap>;

async fn snapshot(client: &Client) -> Result<Snapshot, String> {
    let mut snap: Snapshot = BTreeMap::new();

    let cols = client
        .query(
            r#"select n.nspname || '.' || c.relname,
                      a.attname,
                      format_type(a.atttypid, a.atttypmod),
                      not a.attnotnull,
                      pg_get_expr(d.adbin, d.adrelid)
               from pg_attribute a
               join pg_class c on c.oid = a.attrelid
               join pg_namespace n on n.oid = c.relnamespace
               left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
               where c.relkind in ('r', 'p')
                 and n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
                 and a.attnum > 0 and not a.attisdropped
               order by 1, a.attnum"#,
            &[],
        )
        .await
        .map_err(|e| crate::db::pg_err(&e))?;
    for r in &cols {
        let table: String = r.get(0);
        snap.entry(table).or_default().columns.insert(
            r.get(1),
            ColSnap {
                data_type: r.get(2),
                nullable: r.get(3),
                default_expr: r.get(4),
            },
        );
    }

    let idx = client
        .query(
            r#"select schemaname || '.' || tablename, indexname, indexdef
               from pg_indexes
               where schemaname <> 'information_schema' and schemaname !~ '^pg_'"#,
            &[],
        )
        .await
        .map_err(|e| crate::db::pg_err(&e))?;
    for r in &idx {
        let table: String = r.get(0);
        if let Some(t) = snap.get_mut(&table) {
            t.indexes.insert(r.get(1), r.get(2));
        }
    }

    let cons = client
        .query(
            r#"select n.nspname || '.' || c.relname, con.conname, pg_get_constraintdef(con.oid)
               from pg_constraint con
               join pg_class c on c.oid = con.conrelid
               join pg_namespace n on n.oid = c.relnamespace
               where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'"#,
            &[],
        )
        .await
        .map_err(|e| crate::db::pg_err(&e))?;
    for r in &cons {
        let table: String = r.get(0);
        if let Some(t) = snap.get_mut(&table) {
            t.constraints.insert(r.get(1), r.get(2));
        }
    }

    Ok(snap)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// "+" only in A · "-" only in B · "~" differs
    sign: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDiff {
    table: String,
    lines: Vec<DiffLine>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDiff {
    a_label: String,
    b_label: String,
    only_in_a: Vec<String>,
    only_in_b: Vec<String>,
    changed: Vec<TableDiff>,
    identical: usize,
}

fn col_desc(c: &ColSnap) -> String {
    format!(
        "{}{}{}",
        c.data_type,
        if c.nullable { "" } else { " not null" },
        c.default_expr
            .as_ref()
            .map(|d| format!(" default {d}"))
            .unwrap_or_default()
    )
}

fn diff_snapshots(a: &Snapshot, b: &Snapshot) -> (Vec<String>, Vec<String>, Vec<TableDiff>, usize) {
    let only_in_a: Vec<String> = a.keys().filter(|k| !b.contains_key(*k)).cloned().collect();
    let only_in_b: Vec<String> = b.keys().filter(|k| !a.contains_key(*k)).cloned().collect();
    let mut changed = Vec::new();
    let mut identical = 0usize;

    for (table, ta) in a {
        let Some(tb) = b.get(table) else { continue };
        let mut lines: Vec<DiffLine> = Vec::new();

        for (name, ca) in &ta.columns {
            match tb.columns.get(name) {
                None => lines.push(DiffLine {
                    sign: "+".into(),
                    text: format!("column {name} {}", col_desc(ca)),
                }),
                Some(cb) if ca != cb => lines.push(DiffLine {
                    sign: "~".into(),
                    text: format!("column {name}: {} → {}", col_desc(ca), col_desc(cb)),
                }),
                _ => {}
            }
        }
        for name in tb.columns.keys() {
            if !ta.columns.contains_key(name) {
                lines.push(DiffLine {
                    sign: "-".into(),
                    text: format!("column {name} {}", col_desc(&tb.columns[name])),
                });
            }
        }

        for (kind, ma, mb) in [
            ("index", &ta.indexes, &tb.indexes),
            ("constraint", &ta.constraints, &tb.constraints),
        ] {
            for (name, def) in ma {
                match mb.get(name) {
                    None => lines.push(DiffLine {
                        sign: "+".into(),
                        text: format!("{kind} {name}: {def}"),
                    }),
                    Some(other) if other != def => lines.push(DiffLine {
                        sign: "~".into(),
                        text: format!("{kind} {name}: {def} → {other}"),
                    }),
                    _ => {}
                }
            }
            for name in mb.keys() {
                if !ma.contains_key(name) {
                    lines.push(DiffLine {
                        sign: "-".into(),
                        text: format!("{kind} {name}: {}", mb[name]),
                    });
                }
            }
        }

        if lines.is_empty() {
            identical += 1;
        } else {
            changed.push(TableDiff {
                table: table.clone(),
                lines,
            });
        }
    }
    (only_in_a, only_in_b, changed, identical)
}

/// Diff two saved profiles' schemas. Ephemeral connections; tunnels live for
/// the duration of the snapshots.
#[tauri::command]
pub async fn schema_diff(
    store: State<'_, Store>,
    profile_a: i64,
    profile_b: i64,
) -> Result<SchemaDiff, String> {
    let (pa, pwa) = crate::profiles::load_profile_with_password(&store, profile_a)?;
    let (pb, pwb) = crate::profiles::load_profile_with_password(&store, profile_b)?;

    let (cfg_a, _tun_a) = crate::profiles::prepare(&pa, pwa).await?;
    let ssl_a = crate::db::SslChoice::parse(&pa.ssl_mode);
    let client_a = crate::db::pg_connect(&cfg_a, ssl_a).await?;
    let snap_a = snapshot(&client_a).await?;

    let (cfg_b, _tun_b) = crate::profiles::prepare(&pb, pwb).await?;
    let ssl_b = crate::db::SslChoice::parse(&pb.ssl_mode);
    let client_b = crate::db::pg_connect(&cfg_b, ssl_b).await?;
    let snap_b = snapshot(&client_b).await?;

    let (only_in_a, only_in_b, changed, identical) = diff_snapshots(&snap_a, &snap_b);
    Ok(SchemaDiff {
        a_label: pa.name,
        b_label: pb.name,
        only_in_a,
        only_in_b,
        changed,
        identical,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(cols: &[(&str, &str, &str)]) -> Snapshot {
        // (table, column, type)
        let mut s: Snapshot = BTreeMap::new();
        for (t, c, ty) in cols {
            s.entry(t.to_string()).or_default().columns.insert(
                c.to_string(),
                ColSnap {
                    data_type: ty.to_string(),
                    nullable: true,
                    default_expr: None,
                },
            );
        }
        s
    }

    #[test]
    fn diffs_tables_columns_and_types() {
        let a = snap(&[("public.t1", "id", "int4"), ("public.t1", "name", "text"), ("public.only_a", "x", "int4")]);
        let b = snap(&[("public.t1", "id", "int8"), ("public.t1", "extra", "text"), ("public.only_b", "y", "int4")]);
        let (only_a, only_b, changed, identical) = diff_snapshots(&a, &b);
        assert_eq!(only_a, vec!["public.only_a"]);
        assert_eq!(only_b, vec!["public.only_b"]);
        assert_eq!(identical, 0);
        assert_eq!(changed.len(), 1);
        let lines: Vec<String> = changed[0].lines.iter().map(|l| format!("{}{}", l.sign, l.text)).collect();
        assert!(lines.iter().any(|l| l.starts_with("~column id: int4 → int8")));
        assert!(lines.iter().any(|l| l.starts_with("+column name")));
        assert!(lines.iter().any(|l| l.starts_with("-column extra")));
    }

    #[test]
    fn identical_tables_counted() {
        let a = snap(&[("public.t", "id", "int4")]);
        let (oa, ob, ch, ident) = diff_snapshots(&a, &a.clone_shallow());
        assert!(oa.is_empty() && ob.is_empty() && ch.is_empty());
        assert_eq!(ident, 1);
    }

    trait CloneShallow {
        fn clone_shallow(&self) -> Snapshot;
    }
    impl CloneShallow for Snapshot {
        fn clone_shallow(&self) -> Snapshot {
            let mut s: Snapshot = BTreeMap::new();
            for (k, v) in self {
                let mut t = TableSnap::default();
                t.columns = v.columns.clone();
                t.indexes = v.indexes.clone();
                t.constraints = v.constraints.clone();
                s.insert(k.clone(), t);
            }
            s
        }
    }
}
