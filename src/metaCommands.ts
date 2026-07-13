/**
 * psql-style backslash commands. These were never server commands — psql
 * expands them client-side into catalog queries, and so do we. The expanded
 * SQL runs through the normal pipeline (grid, history, export).
 */

export type MetaResult =
  | { kind: "sql"; sql: string; title: string }
  | { kind: "describe"; name: string }
  | { kind: "conninfo" }
  | { kind: "help"; unknown?: string };

/** Shared by the editor interception and the sidebar Server section. */
export const META_QUERIES: Record<string, { title: string; sql: string }> = {
  du: {
    title: "roles",
    sql: `select r.rolname as role,
       r.rolsuper as super,
       r.rolcreaterole as create_role,
       r.rolcreatedb as create_db,
       r.rolcanlogin as login,
       r.rolreplication as replication,
       r.rolconnlimit as conn_limit,
       r.rolvaliduntil as valid_until,
       array(select b.rolname
             from pg_auth_members m
             join pg_roles b on m.roleid = b.oid
             where m.member = r.oid) as member_of
from pg_roles r
order by r.rolname;`,
  },
  l: {
    title: "databases",
    sql: `select d.datname as name,
       pg_get_userbyid(d.datdba) as owner,
       pg_encoding_to_char(d.encoding) as encoding,
       d.datcollate as collate,
       case when has_database_privilege(d.datname, 'CONNECT')
            then pg_size_pretty(pg_database_size(d.datname)) end as size
from pg_database d
where not d.datistemplate
order by 1;`,
  },
  dn: {
    title: "schemas",
    sql: `select n.nspname as name, pg_get_userbyid(n.nspowner) as owner
from pg_namespace n
where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
order by 1;`,
  },
  dt: {
    title: "tables",
    sql: `select schemaname as schema,
       tablename as name,
       tableowner as owner,
       pg_size_pretty(pg_total_relation_size(format('%I.%I', schemaname, tablename)::regclass)) as size
from pg_tables
where schemaname !~ '^pg_' and schemaname <> 'information_schema'
order by 1, 2;`,
  },
  dv: {
    title: "views",
    sql: `select schemaname as schema, viewname as name, viewowner as owner
from pg_views
where schemaname !~ '^pg_' and schemaname <> 'information_schema'
order by 1, 2;`,
  },
  dm: {
    title: "matviews",
    sql: `select schemaname as schema, matviewname as name, matviewowner as owner, ispopulated
from pg_matviews
order by 1, 2;`,
  },
  df: {
    title: "functions",
    sql: `select n.nspname as schema,
       p.proname as name,
       pg_get_function_result(p.oid) as returns,
       pg_get_function_arguments(p.oid) as arguments,
       case p.prokind when 'f' then 'function' when 'a' then 'aggregate'
                      when 'w' then 'window' when 'p' then 'procedure' end as kind
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
order by 1, 2;`,
  },
  dx: {
    title: "extensions",
    sql: `select e.extname as name, e.extversion as version, n.nspname as schema, d.description
from pg_extension e
join pg_namespace n on n.oid = e.extnamespace
left join pg_description d on d.objoid = e.oid
order by 1;`,
  },
  di: {
    title: "indexes",
    sql: `select schemaname as schema,
       indexname as name,
       tablename as table,
       pg_size_pretty(pg_relation_size(format('%I.%I', schemaname, indexname)::regclass)) as size
from pg_indexes
where schemaname !~ '^pg_' and schemaname <> 'information_schema'
order by 1, 3, 2;`,
  },
  ds: {
    title: "sequences",
    sql: `select schemaname as schema, sequencename as name, data_type, last_value
from pg_sequences
order by 1, 2;`,
  },
};

/** Extra sidebar-only entries (not psql commands, but the same spirit). */
export const SERVER_QUERIES: { key: string; label: string; title: string; sql: string }[] = [
  { key: "roles", label: "Roles", ...META_QUERIES.du },
  { key: "databases", label: "Databases", ...META_QUERIES.l },
  { key: "schemas", label: "Schemas", ...META_QUERIES.dn },
  { key: "extensions", label: "Extensions", ...META_QUERIES.dx },
  {
    key: "settings",
    label: "Settings",
    title: "settings",
    sql: `select name, setting, unit, short_desc
from pg_settings
order by name;`,
  },
  {
    key: "activity",
    label: "Activity",
    title: "activity",
    sql: `select pid, usename as user, state, application_name as app,
       query_start, left(query, 150) as query
from pg_stat_activity
where pid <> pg_backend_pid()
order by query_start desc nulls last;`,
  },
];

export const META_HELP = `supported backslash commands (client-side, like psql):

  \\du         roles                 \\dt         tables (+ sizes)
  \\l          databases             \\dv         views
  \\dn         schemas               \\dm         materialized views
  \\dx         extensions            \\df         functions
  \\di         indexes (+ sizes)     \\ds         sequences
  \\d <table>  structure view        \\conninfo   connection info
  \\?          this help

everything else you'd type in psql is just SQL — run it directly.`;

/** Translate one statement if it's a backslash command; null = plain SQL. */
export function translateMeta(input: string): MetaResult | null {
  const t = input.trim().replace(/;$/, "").trim();
  if (!t.startsWith("\\")) return null;
  const m = /^\\([a-zA-Z?+]+)(?:\s+(.+))?$/.exec(t);
  if (!m) return { kind: "help", unknown: t };
  const cmd = m[1].replace(/\+$/, ""); // \dt+ behaves like \dt
  const arg = m[2]?.trim();

  if (cmd === "?") return { kind: "help" };
  if (cmd === "conninfo") return { kind: "conninfo" };
  if (cmd === "d" && arg) return { kind: "describe", name: arg.replace(/"/g, "") };
  if (cmd === "d" && !arg) return { kind: "sql", ...META_QUERIES.dt };
  if (cmd === "dg") return { kind: "sql", ...META_QUERIES.du };
  const q = META_QUERIES[cmd];
  if (q) return { kind: "sql", ...q };
  return { kind: "help", unknown: t };
}
