import { describe, expect, it } from "vitest";
import { confirmDangerous } from "./sqlSafety";

describe("confirmDangerous", () => {
  it("selects and DDL-creates run freely", () => {
    expect(confirmDangerous("select * from t")).toBeNull();
    expect(confirmDangerous("create table t(id int)")).toBeNull();
    expect(confirmDangerous("insert into t values (1)")).toBeNull();
  });

  it("update/delete with a WHERE run freely", () => {
    expect(confirmDangerous("update t set x = 1 where id = 2")).toBeNull();
    expect(confirmDangerous("delete from t where id = 2")).toBeNull();
  });

  it("update/delete without WHERE warn", () => {
    expect(confirmDangerous("update t set x = 1")).toContain("UPDATE");
    expect(confirmDangerous("delete from t")).toContain("DELETE");
  });

  it("a 'where' inside a string literal does not count", () => {
    expect(confirmDangerous("update t set note = 'where credit is due'")).toContain("UPDATE");
  });

  it("a 'where' inside a comment does not count", () => {
    expect(confirmDangerous("update t set x = 1 -- where id = 2")).toContain("UPDATE");
    expect(confirmDangerous("update t set x = 1 /* where */")).toContain("UPDATE");
  });

  it("leading comments do not hide the verb", () => {
    expect(confirmDangerous("-- cleanup\ndelete from t")).toContain("DELETE");
  });

  it("truncate and drop always warn", () => {
    expect(confirmDangerous("truncate player_items")).toContain("TRUNCATE");
    expect(confirmDangerous("drop table t")).toContain("DROP");
    expect(confirmDangerous("DROP INDEX idx")).toContain("DROP");
  });
});
