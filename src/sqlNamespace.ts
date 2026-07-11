import type { Completion } from "@codemirror/autocomplete";
import type { SQLNamespace } from "@codemirror/lang-sql";

export type CatalogColumn = { name: string; dataType: string };
export type CatalogTable = { schema: string; name: string; columns: CatalogColumn[] };

/**
 * Shape the catalog for @codemirror/lang-sql: nested schema -> table ->
 * column completions, with the column's type shown as detail text.
 */
export function buildNamespace(catalog: CatalogTable[]): SQLNamespace {
  const ns: Record<string, Record<string, Completion[]>> = {};
  for (const t of catalog) {
    (ns[t.schema] ??= {})[t.name] = t.columns.map((c) => ({
      label: c.name,
      type: "property",
      detail: c.dataType,
    }));
  }
  return ns;
}
