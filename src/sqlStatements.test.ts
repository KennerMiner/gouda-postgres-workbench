import { describe, expect, it } from "vitest";
import { splitStatements, statementAt } from "./sqlStatements";

const stmts = (text: string) =>
  splitStatements(text).map((r) => text.slice(r.from, r.to).trim());

describe("splitStatements", () => {
  it("splits plain statements", () => {
    expect(stmts("select 1; select 2;")).toEqual(["select 1", "select 2"]);
  });

  it("ignores trailing whitespace-only fragment", () => {
    expect(stmts("select 1;\n\n")).toEqual(["select 1"]);
  });

  it("splits a DELETE + several INSERTs with string literals", () => {
    // Regression: this buffer used to reach the extended protocol whole and
    // fail with "cannot insert multiple commands into a prepared statement".
    const script =
      "DELETE FROM ages;\n" +
      "INSERT INTO ages (name, age) VALUES ('Bayley', 24);\n" +
      "INSERT INTO ages (name, age) VALUES ('Jayda', 16);\n";
    expect(stmts(script)).toEqual([
      "DELETE FROM ages",
      "INSERT INTO ages (name, age) VALUES ('Bayley', 24)",
      "INSERT INTO ages (name, age) VALUES ('Jayda', 16)",
    ]);
  });

  it("ignores semicolons in single-quoted strings, with '' escapes", () => {
    expect(stmts("select 'a;b'; select 'it''s; fine';")).toEqual([
      "select 'a;b'",
      "select 'it''s; fine'",
    ]);
  });

  it("ignores semicolons in quoted identifiers", () => {
    expect(stmts('select 1 as "a;b"; select 2;')).toEqual(['select 1 as "a;b"', "select 2"]);
  });

  it("ignores semicolons in dollar quotes, tagged and bare", () => {
    expect(stmts("select $$x;y$$; select $fn$a;b$fn$;")).toEqual([
      "select $$x;y$$",
      "select $fn$a;b$fn$",
    ]);
  });

  it("ignores semicolons in comments", () => {
    expect(stmts("select 1 -- no; split\n; select 2 /* not; here */;")).toEqual([
      "select 1 -- no; split",
      "select 2 /* not; here */",
    ]);
  });

  it("handles unterminated string without hanging", () => {
    expect(stmts("select 'oops")).toEqual(["select 'oops"]);
  });

  it("handles $ that is not a dollar quote", () => {
    expect(stmts("select 2 $ 3; select 4;")).toEqual(["select 2 $ 3", "select 4"]);
  });
});

describe("statementAt", () => {
  const text = "select 1;\nselect 2;\n\nselect 3;";

  it("picks the statement containing the cursor", () => {
    expect(statementAt(text, text.indexOf("2"))).toBe("select 2");
  });

  it("picks the statement above when cursor is on a blank line below it", () => {
    expect(statementAt(text, text.indexOf("\n\n") + 1)).toBe("select 2");
  });

  it("picks the last statement at end of doc", () => {
    expect(statementAt(text, text.length)).toBe("select 3");
  });

  it("returns null for empty doc", () => {
    expect(statementAt("", 0)).toBeNull();
    expect(statementAt("  \n ", 1)).toBeNull();
  });
});
