import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./fuzzy";
import { estimateFactor, inclusiveTime, selfTime, type PlanNode } from "./PlanView";

describe("fuzzyScore", () => {
  it("empty query matches everything neutrally", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });

  it("prefers prefix over mid-string over subsequence", () => {
    const prefix = fuzzyScore("pla", "player_items")!;
    const mid = fuzzyScore("items", "player_items")!;
    const subseq = fuzzyScore("pli", "player_items")!;
    expect(prefix).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(subseq);
  });

  it("word-boundary matches beat buried ones", () => {
    expect(fuzzyScore("items", "player_items")!).toBeGreaterThan(
      fuzzyScore("items", "xitemsy")!,
    );
  });

  it("returns null when chars missing", () => {
    expect(fuzzyScore("xyz", "player")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("OPEN", "Open public.bosses")).not.toBeNull();
  });
});

describe("plan helpers", () => {
  const node = (t: number | undefined, loops: number, kids: PlanNode[] = []): PlanNode => ({
    "Node Type": "x",
    ...(t !== undefined ? { "Actual Total Time": t, "Actual Loops": loops } : {}),
    Plans: kids,
  });

  it("inclusive time multiplies by loops", () => {
    expect(inclusiveTime(node(2.5, 4))).toBe(10);
    expect(inclusiveTime(node(undefined, 1))).toBeNull();
  });

  it("self time subtracts children and clamps at zero", () => {
    const n = node(10, 1, [node(4, 1), node(3, 2)]); // children: 4 + 6
    expect(selfTime(n)).toBe(0);
    const m = node(10, 1, [node(2, 1)]);
    expect(selfTime(m)).toBe(8);
  });

  it("estimate factor is symmetric and >= 1", () => {
    const over: PlanNode = { "Node Type": "x", "Plan Rows": 1000, "Actual Rows": 10, "Actual Loops": 1 };
    const under: PlanNode = { "Node Type": "x", "Plan Rows": 10, "Actual Rows": 1000, "Actual Loops": 1 };
    expect(estimateFactor(over)).toBe(100);
    expect(estimateFactor(under)).toBe(100);
  });
});
