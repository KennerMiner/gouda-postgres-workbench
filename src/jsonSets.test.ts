import { describe, expect, it } from "vitest";
import { applyJsonSets } from "./jsonSets";

describe("applyJsonSets", () => {
  const doc = { a: { b: [10, 20] }, keep: true };

  it("sets a nested leaf without touching siblings", () => {
    const out = applyJsonSets(doc, [{ path: ["a", "b", 1], value: "99" }]) as typeof doc;
    expect(out).toEqual({ a: { b: [10, 99] }, keep: true });
    expect(doc.a.b[1]).toBe(20); // original untouched
  });

  it("applies sets in order", () => {
    const out = applyJsonSets(doc, [
      { path: ["keep"], value: "false" },
      { path: ["keep"], value: "42" },
    ]) as Record<string, unknown>;
    expect(out.keep).toBe(42);
  });

  it("creates the final key if missing (create_missing)", () => {
    const out = applyJsonSets(doc, [{ path: ["a", "new"], value: '"x"' }]) as Record<
      string,
      { new?: string }
    >;
    expect(out.a.new).toBe("x");
  });

  it("missing intermediate is a no-op, like jsonb_set", () => {
    const out = applyJsonSets(doc, [{ path: ["nope", "deep"], value: "1" }]);
    expect(out).toEqual(doc);
  });

  it("scalar intermediate is a no-op", () => {
    const out = applyJsonSets(doc, [{ path: ["keep", "deep"], value: "1" }]);
    expect(out).toEqual(doc);
  });

  it("null/scalar documents are returned unchanged", () => {
    expect(applyJsonSets(null, [{ path: ["a"], value: "1" }])).toBeNull();
  });
});
