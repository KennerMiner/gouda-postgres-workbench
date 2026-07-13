import { describe, expect, it } from "vitest";
import { rowsToInsert, rowsToTsv } from "./rowCopy";
import type { ColumnMeta } from "./Grid";

const col = (name: string, typeName = "text"): ColumnMeta => ({ name, typeName, typeOid: 0 });

describe("rowsToTsv", () => {
  it("joins with tabs, flattens embedded tabs/newlines, NULL empty", () => {
    expect(
      rowsToTsv([
        [1, "a\tb", null],
        [2, "line\nbreak", { x: 1 }],
      ]),
    ).toBe('1\ta  b\t\n2\tline break\t{"x":1}');
  });
});

describe("rowsToInsert", () => {
  it("bare numerics/bools, quoted strings with escapes, NULL, json quoted", () => {
    const sql = rowsToInsert(
      '"public"."items"',
      [col("id", "int8"), col("name"), col("active", "bool"), col("payload", "jsonb")],
      [
        [7, "O'Neil", true, { a: 1 }],
        [8, null, false, null],
      ],
    );
    expect(sql).toBe(
      `insert into "public"."items" ("id", "name", "active", "payload") values\n` +
        `  (7, 'O''Neil', true, '{"a":1}'),\n` +
        `  (8, NULL, false, NULL);`,
    );
  });

  it("empty rows yield empty string", () => {
    expect(rowsToInsert("t", [col("a")], [])).toBe("");
  });
});
