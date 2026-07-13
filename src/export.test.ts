import { describe, expect, it } from "vitest";
import { toCsv, toJson } from "./export";
import type { ColumnMeta } from "./Grid";

const col = (name: string): ColumnMeta => ({ name, typeName: "text", typeOid: 25 });

describe("toCsv", () => {
  it("quotes only when needed, escapes quotes, NULL is empty", () => {
    const csv = toCsv(
      [col("id"), col("name"), col("note")],
      [
        [1, "plain", null],
        [2, 'has "quotes"', "a,b"],
        [3, "line\nbreak", "ok"],
      ],
    );
    expect(csv).toBe(
      'id,name,note\r\n1,plain,\r\n2,"has ""quotes""","a,b"\r\n3,"line\nbreak",ok\r\n',
    );
  });

  it("serializes json cells compactly", () => {
    const csv = toCsv([col("payload")], [[{ a: 1 }]]);
    expect(csv).toContain('"{""a"":1}"');
  });
});

describe("toJson", () => {
  it("keys rows by column name and keeps types", () => {
    const out = JSON.parse(toJson([col("id"), col("payload")], [[7, { a: [1, null] }]]));
    expect(out).toEqual([{ id: 7, payload: { a: [1, null] } }]);
  });
});
