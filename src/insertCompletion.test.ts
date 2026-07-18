import { describe, it, expect } from "vitest";
import { insertColumnList, insertColumnCandidates, unquoteIdent } from "./insertCompletion";
import type { CatalogTable } from "./sqlNamespace";

const catalog: CatalogTable[] = [
  {
    schema: "public",
    name: "artists",
    columns: [
      { name: "id", dataType: "int4" },
      { name: "name", dataType: "text" },
      { name: "country", dataType: "text" },
    ],
  },
  {
    schema: "music",
    name: "artists",
    columns: [{ name: "mid", dataType: "int4" }],
  },
];

const names = (t: string) => insertColumnCandidates(catalog, t)?.map((c) => c.name) ?? null;

describe("insertColumnList", () => {
  it("detects an open column list and captures table + partial", () => {
    expect(insertColumnList("insert into artists (")).toEqual({ ref: "artists", partial: "" });
    expect(insertColumnList("INSERT INTO artists (id, ")).toEqual({
      ref: "artists",
      partial: "id, ",
    });
  });

  it("does not fire inside the VALUES list (closed column parens)", () => {
    expect(insertColumnList("insert into artists (id) values (")).toBeNull();
  });

  it("ignores non-insert statements", () => {
    expect(insertColumnList("select * from artists (")).toBeNull();
    expect(insertColumnList("insert into artists ")).toBeNull();
  });

  it("targets the active insert in a multi-statement buffer", () => {
    const t = "insert into artists (id) values (1);\ninsert into artists (name, ";
    expect(insertColumnList(t)).toEqual({ ref: "artists", partial: "name, " });
  });
});

describe("insertColumnCandidates", () => {
  it("offers all columns right after the paren", () => {
    expect(names("insert into artists (")).toEqual(["id", "name", "country"]);
  });

  it("excludes already-listed columns and resets after a comma", () => {
    expect(names("insert into artists (id, ")).toEqual(["name", "country"]);
    expect(names("insert into artists (id, name, ")).toEqual(["country"]);
  });

  it("still offers a column while it is being typed", () => {
    // 'na' is the current word, not yet committed, so 'name' stays offered.
    expect(names("insert into artists (id, na")).toEqual(["name", "country"]);
  });

  it("returns null once every column is listed", () => {
    expect(names("insert into artists (id, name, country, ")).toBeNull();
  });

  it("prefers the public schema for a bare table name", () => {
    expect(names("insert into artists (")).toContain("name");
  });

  it("resolves a schema-qualified table", () => {
    expect(names("insert into music.artists (")).toEqual(["mid"]);
  });

  it("returns null for an unknown table", () => {
    expect(names("insert into nope (")).toBeNull();
  });
});

describe("unquoteIdent", () => {
  it("lower-cases bare identifiers", () => {
    expect(unquoteIdent("Artists")).toBe("artists");
  });
  it("preserves case inside double quotes", () => {
    expect(unquoteIdent('"Artists"')).toBe("Artists");
    expect(unquoteIdent('"a""b"')).toBe('a"b');
  });
});
