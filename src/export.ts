import type { ColumnMeta } from "./Grid";

function cellStr(v: unknown): string {
  if (v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function csvField(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC-4180-ish CSV: CRLF lines, quoted only when needed, NULL as empty. */
export function toCsv(columns: ColumnMeta[], rows: unknown[][]): string {
  const lines = [columns.map((c) => csvField(c.name)).join(",")];
  for (const r of rows) {
    lines.push(r.map((v) => csvField(cellStr(v))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/** Array of objects keyed by column name; values keep their JSON types. */
export function toJson(columns: ColumnMeta[], rows: unknown[][]): string {
  return JSON.stringify(
    rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i]]))),
    null,
    2,
  );
}
