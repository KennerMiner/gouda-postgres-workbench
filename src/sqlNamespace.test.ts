import { describe, expect, it } from "vitest";
import { buildNamespace } from "./sqlNamespace";

describe("buildNamespace", () => {
  it("nests schema → table → column completions with types as detail", () => {
    const ns = buildNamespace([
      {
        schema: "public",
        name: "players",
        columns: [
          { name: "player_id", dataType: "text" },
          { name: "created_at", dataType: "timestamptz" },
        ],
      },
      { schema: "audit", name: "log", columns: [{ name: "id", dataType: "bigint" }] },
    ]) as Record<string, Record<string, { label: string; detail?: string }[]>>;

    expect(Object.keys(ns).sort()).toEqual(["audit", "public"]);
    expect(ns.public.players.map((c) => c.label)).toEqual(["player_id", "created_at"]);
    expect(ns.public.players[1].detail).toBe("timestamptz");
    expect(ns.audit.log[0].label).toBe("id");
  });
});
