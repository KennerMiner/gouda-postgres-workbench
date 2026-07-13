import { describe, expect, it } from "vitest";
import { computeOrder } from "./gridSort";
import type { ColumnMeta } from "./Grid";

const cols: ColumnMeta[] = [
  { name: "n", typeName: "int4", typeOid: 23 },
  { name: "s", typeName: "text", typeOid: 25 },
];

const rows: unknown[][] = [
  [3, "banana"],
  [null, "apple"],
  [10, null],
  [2, "Cherry"],
];

describe("computeOrder", () => {
  it("no sort returns identity (source order)", () => {
    expect(computeOrder(rows, null, cols)).toEqual([0, 1, 2, 3]);
  });

  it("numeric sort compares as numbers, NULLs last", () => {
    expect(computeOrder(rows, { c: 0, dir: 1 }, cols)).toEqual([3, 0, 2, 1]); // 2,3,10,null
    expect(computeOrder(rows, { c: 0, dir: -1 }, cols)).toEqual([2, 0, 3, 1]); // 10,3,2,null
  });

  it("text sort, NULLs last in both directions", () => {
    const asc = computeOrder(rows, { c: 1, dir: 1 }, cols);
    expect(asc[asc.length - 1]).toBe(2); // null row last
    expect(asc[0]).toBe(1); // apple first
    const desc = computeOrder(rows, { c: 1, dir: -1 }, cols);
    expect(desc[desc.length - 1]).toBe(2); // null still last
  });

  it("returns a permutation — sorting never loses or duplicates rows", () => {
    const order = computeOrder(rows, { c: 0, dir: 1 }, cols);
    expect([...order].sort()).toEqual([0, 1, 2, 3].map(String).sort().map(Number));
  });
});
