import type { CatalogTable } from "./sqlNamespace";

const IDENT = `(?:"[^"]+"|[A-Za-z_][\\w$]*)`;
// An open INSERT column list: `insert into <table> ( <cols so far>` with no
// closing paren yet (so it excludes the VALUES list that follows). Captures
// the table ref and the partial column list up to the cursor.
const INSERT_COLS_RE = new RegExp(
  `insert\\s+into\\s+(${IDENT}(?:\\s*\\.\\s*${IDENT})?)\\s*\\(([^()]*)$`,
  "i",
);

/** If the cursor sits in an INSERT column list, the target table + typed cols. */
export function insertColumnList(
  textBeforeCursor: string,
): { ref: string; partial: string } | null {
  const m = INSERT_COLS_RE.exec(textBeforeCursor);
  return m ? { ref: m[1], partial: m[2] } : null;
}

/** Lower-case an identifier, honoring double-quotes (which preserve case). */
export function unquoteIdent(s: string): string {
  const t = s.trim();
  return t.startsWith('"') ? t.slice(1, -1).replace(/""/g, '"') : t.toLowerCase();
}

/**
 * Columns to offer for an INSERT column list at the cursor: the target table's
 * columns minus any already listed. Returns null when the cursor isn't in such
 * a list or the table/columns can't be resolved from the catalog.
 */
export function insertColumnCandidates(
  catalog: CatalogTable[],
  textBeforeCursor: string,
): CatalogTable["columns"] | null {
  const ctx = insertColumnList(textBeforeCursor);
  if (!ctx) return null;
  const parts = ctx.ref.split(".").map(unquoteIdent);
  let cols: CatalogTable["columns"] | undefined;
  if (parts.length > 1) {
    cols = catalog.find(
      (t) => t.schema.toLowerCase() === parts[0] && t.name.toLowerCase() === parts[1],
    )?.columns;
  } else {
    const matches = catalog.filter((t) => t.name.toLowerCase() === parts[0]);
    cols = (matches.find((t) => t.schema === "public") ?? matches[0])?.columns;
  }
  if (!cols?.length) return null;
  const listed = new Set(
    ctx.partial.split(",").slice(0, -1).map(unquoteIdent).filter(Boolean),
  );
  const remaining = cols.filter((c) => !listed.has(c.name.toLowerCase()));
  return remaining.length ? remaining : null;
}
