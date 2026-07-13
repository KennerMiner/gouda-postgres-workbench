import type { ColumnMeta } from "./Grid";

export type SortSpec = { c: number; dir: 1 | -1 } | null;

const NUMERIC_TYPES = new Set([
  "int2",
  "int4",
  "int8",
  "float4",
  "float8",
  "numeric",
  "oid",
  "money",
]);

function cellText(v: unknown): string {
  if (v === null) return "NULL";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Display order for the grid: a permutation of source indices. Sorting never
 * moves the underlying rows — staged edits, deletions, and selections stay
 * keyed to source indices and remain attached to their rows.
 * NULLs sort last regardless of direction.
 */
export function computeOrder(rows: unknown[][], sort: SortSpec, columns: ColumnMeta[]): number[] {
  const idx = rows.map((_, i) => i);
  if (!sort) return idx;
  const { c, dir } = sort;
  const numeric = NUMERIC_TYPES.has(columns[c]?.typeName ?? "");
  idx.sort((a, b) => {
    const va = rows[a][c];
    const vb = rows[b][c];
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    let cmp: number;
    if (numeric || (typeof va === "number" && typeof vb === "number")) {
      cmp = Number(va) - Number(vb);
    } else {
      cmp = cellText(va).localeCompare(cellText(vb));
    }
    return cmp * dir;
  });
  return idx;
}
