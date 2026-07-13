import { describe, expect, it } from "vitest";
import { translateMeta } from "./metaCommands";

describe("translateMeta", () => {
  it("plain SQL passes through untouched", () => {
    expect(translateMeta("select 1;")).toBeNull();
    expect(translateMeta("  update t set x = 1")).toBeNull();
  });

  it("translates \\du to a roles query", () => {
    const r = translateMeta("\\du");
    expect(r?.kind).toBe("sql");
    if (r?.kind === "sql") {
      expect(r.sql).toContain("pg_roles");
      expect(r.title).toBe("roles");
    }
  });

  it("handles trailing semicolons and + variants", () => {
    expect(translateMeta("\\dt+;")?.kind).toBe("sql");
    expect(translateMeta("\\l;")?.kind).toBe("sql");
  });

  it("\\d with a name describes, without lists tables", () => {
    const named = translateMeta('\\d "player_items"');
    expect(named).toEqual({ kind: "describe", name: "player_items" });
    const schema = translateMeta("\\d public.bosses");
    expect(schema).toEqual({ kind: "describe", name: "public.bosses" });
    const bare = translateMeta("\\d");
    expect(bare?.kind).toBe("sql");
  });

  it("\\? gives help, unknown commands give help with the input", () => {
    expect(translateMeta("\\?")).toEqual({ kind: "help" });
    const unknown = translateMeta("\\watch 5");
    expect(unknown?.kind).toBe("help");
    if (unknown?.kind === "help") expect(unknown.unknown).toContain("\\watch");
  });

  it("\\conninfo and \\dg alias", () => {
    expect(translateMeta("\\conninfo")).toEqual({ kind: "conninfo" });
    expect(translateMeta("\\dg")?.kind).toBe("sql");
  });
});
