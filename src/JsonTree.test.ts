import { describe, expect, it } from "vitest";
import { computeKeep, pgPath } from "./JsonTree";

describe("pgPath", () => {
  it("builds operator chains, ->> for scalar leaves", () => {
    expect(pgPath("payload", ["rolledStats", 0, "statId"], true)).toBe(
      `"payload"->'rolledStats'->0->>'statId'`,
    );
  });

  it("uses -> for container leaves", () => {
    expect(pgPath("payload", ["gemSlots", 2], false)).toBe(`"payload"->'gemSlots'->2`);
  });

  it("bare column for empty path", () => {
    expect(pgPath("payload", [], false)).toBe(`"payload"`);
  });

  it("escapes quotes in keys and column names", () => {
    expect(pgPath(`we"ird`, ["it's"], true)).toBe(`"we""ird"->>'it''s'`);
  });
});

describe("computeKeep", () => {
  const doc = {
    definitionId: "eq_fire_t1",
    gemSlots: [{ unlocked: false }, { unlocked: true }],
    rolledStats: [{ statId: "pctStrengthBuff" }],
  };

  const key = (p: (string | number)[]) => p.join("");

  it("keeps matches, their ancestors, and match count", () => {
    const { keep, matches } = computeKeep(doc, "pctstrength");
    expect(matches).toBe(1);
    expect(keep.has(key([]))).toBe(true);
    expect(keep.has(key(["rolledStats"]))).toBe(true);
    expect(keep.has(key(["rolledStats", 0]))).toBe(true);
    expect(keep.has(key(["rolledStats", 0, "statId"]))).toBe(true);
    expect(keep.has(key(["gemSlots"]))).toBe(false);
  });

  it("a matching key keeps its whole subtree", () => {
    const { keep } = computeKeep(doc, "gemslots");
    expect(keep.has(key(["gemSlots"]))).toBe(true);
    expect(keep.has(key(["gemSlots", 0, "unlocked"]))).toBe(true);
    expect(keep.has(key(["rolledStats"]))).toBe(false);
  });

  it("matches values case-insensitively", () => {
    const { matches } = computeKeep(doc, "EQ_FIRE");
    expect(matches).toBe(1);
  });

  it("no matches yields empty keep", () => {
    const { keep, matches } = computeKeep(doc, "zzz");
    expect(matches).toBe(0);
    expect(keep.size).toBe(0);
  });

  it("boolean and numeric values match by text", () => {
    const { matches } = computeKeep(doc, "true");
    expect(matches).toBe(1);
  });
});
