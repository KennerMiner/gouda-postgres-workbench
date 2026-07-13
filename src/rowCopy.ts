import type { ColumnMeta } from "./Grid";

const BARE_TYPES = new Set([
  "int2",
  "int4",
  "int8",
  "float4",
  "float8",
  "numeric",
  "oid",
  "bool",
]);

function cellStr(v: unknown): string {
  if (v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Tab-separated values, no header — pastes cleanly into spreadsheets. */
export function rowsToTsv(rows: unknown[][]): string {
  return rows
    .map((r) => r.map((v) => cellStr(v).replace(/\t/g, "  ").replace(/\n/g, " ")).join("\t"))
    .join("\n");
}

function sqlLiteral(v: unknown, typeName: string): string {
  if (v === null) return "NULL";
  if (BARE_TYPES.has(typeName) && (typeof v === "number" || typeof v === "boolean")) {
    return String(v);
  }
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return `'${s.replace(/'/g, "''")}'`;
}

/** Multi-row INSERT for the given rows; table pre-quoted by the caller. */
export function rowsToInsert(table: string, columns: ColumnMeta[], rows: unknown[][]): string {
  if (rows.length === 0) return "";
  const cols = columns.map((c) => `"${c.name.replace(/"/g, '""')}"`).join(", ");
  const values = rows
    .map((r) => `  (${r.map((v, i) => sqlLiteral(v, columns[i].typeName)).join(", ")})`)
    .join(",\n");
  return `insert into ${table} (${cols}) values\n${values};`;
}
